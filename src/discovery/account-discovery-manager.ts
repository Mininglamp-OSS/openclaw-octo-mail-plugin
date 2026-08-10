import { join } from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { PluginAccountRuntime } from "../accounts/account-runtime-registry.js";
import type { AgentDispatcher } from "../openclaw/agent-dispatcher.js";
import {
  MailClientError,
  supportsMailPushDiscovery,
  type MailPushDiscoveryClient,
} from "../mail/mail-client.js";
import { FileDiscoveryStateStore } from "./discovery-state-store.js";
import {
  FatalDiscoveryError,
  MailChangesPoller,
} from "./mail-changes-poller.js";

export interface AccountDiscoveryManagerOptions {
  logger: PluginLogger;
  createDispatcher: (runtime: PluginAccountRuntime) => AgentDispatcher;
}

interface ActiveDiscovery {
  controller: AbortController;
  loop: Promise<void>;
}

/** Owns one non-overlapping JMAP Email/changes loop per active Plugin Account. */
export class AccountDiscoveryManager {
  readonly #options: AccountDiscoveryManagerOptions;
  readonly #active = new Map<string, ActiveDiscovery>();
  #stateDir: string | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(options: AccountDiscoveryManagerOptions) {
    this.#options = options;
  }

  async start(
    stateDir: string,
    runtimes: readonly PluginAccountRuntime[],
  ): Promise<void> {
    if (this.#stopPromise !== undefined) {
      await this.#stopPromise;
    }
    if (this.#stateDir !== undefined) {
      throw new Error("octo-mail account discovery manager already started");
    }
    this.#stateDir = stateDir;
    for (const runtime of runtimes) {
      await this.activate(runtime);
    }
  }

  async activate(runtime: PluginAccountRuntime): Promise<void> {
    if (this.#stateDir === undefined || this.#stopPromise !== undefined) {
      return;
    }
    await this.#stopAccount(runtime.config.pluginAccountId);
    if (!runtime.config.discovery.enabled) {
      return;
    }

    const controller = new AbortController();
    const poller = new MailChangesPoller({
      client: runtime.client,
      stateStore: new FileDiscoveryStateStore(
        join(
          this.#stateDir,
          "plugins",
          "octo-mail",
          "discovery",
          `${runtime.config.pluginAccountId}.json`,
        ),
      ),
      dispatcher: this.#options.createDispatcher(runtime),
      logger: this.#options.logger,
      maxChanges: runtime.config.discovery.maxChanges,
    });
    const loop = this.#runLoop(runtime, poller, controller.signal);
    this.#active.set(runtime.config.pluginAccountId, { controller, loop });
    this.#options.logger.info(
      `[octo-mail] mail discovery started for Plugin Account ${runtime.config.pluginAccountId}`,
    );
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return await this.#stopPromise;
    }
    const operation = this.#stop();
    this.#stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#stopPromise === operation) {
        this.#stopPromise = undefined;
      }
    }
  }

  async #stop(): Promise<void> {
    await Promise.all(
      [...this.#active.keys()].map((id) => this.#stopAccount(id)),
    );
    this.#stateDir = undefined;
  }

  async #runLoop(
    runtime: PluginAccountRuntime,
    poller: MailChangesPoller,
    signal: AbortSignal,
  ): Promise<void> {
    const client = runtime.client;
    if (supportsMailPushDiscovery(client)) {
      return await this.#runPushLoop(runtime, client, poller, signal);
    }

    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        const result = await poller.pollOnce(signal);
        consecutiveFailures = 0;
        if (result.emailsDispatched > 0) {
          this.#options.logger.info(
            `[octo-mail] dispatched ${result.emailsDispatched} Inbox email(s) for Plugin Account ${runtime.config.pluginAccountId}`,
          );
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : "unknown error";
        if (error instanceof FatalDiscoveryError) {
          this.#options.logger.error(
            `[octo-mail] mail discovery stopped for Plugin Account ${runtime.config.pluginAccountId}: ${message}`,
          );
          return;
        }
        if (
          error instanceof MailClientError &&
          (error.status === 401 || error.status === 403)
        ) {
          this.#options.logger.error(
            `[octo-mail] mail discovery stopped for Plugin Account ${runtime.config.pluginAccountId}: stored credential is invalid or revoked`,
          );
          return;
        }
        consecutiveFailures += 1;
        this.#options.logger.error(
          `[octo-mail] mail discovery poll failed for Plugin Account ${runtime.config.pluginAccountId}: ${message}`,
        );
      }
      await abortableDelay(
        resolveDiscoveryDelayMs(
          runtime.config.discovery.pollIntervalMs,
          consecutiveFailures,
        ),
        signal,
      );
    }
  }

  async #runPushLoop(
    runtime: PluginAccountRuntime,
    client: PluginAccountRuntime["client"] & MailPushDiscoveryClient,
    poller: MailChangesPoller,
    signal: AbortSignal,
  ): Promise<void> {
    let consecutiveFailures = 0;
    while (!signal.aborted) {
      try {
        await this.#pollAndLog(runtime, poller, signal);
        consecutiveFailures = 0;
        this.#options.logger.info(
          `[octo-mail] JMAP EventSource connected for Plugin Account ${runtime.config.pluginAccountId}`,
        );
        await client.watchEmailStateChanges(async () => {
          await this.#pollAndLog(runtime, poller, signal);
          consecutiveFailures = 0;
        }, signal);
        // The client periodically recycles a healthy long-running connection;
        // run Email/changes once more before opening the next one.
        continue;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (this.#logPermanentStop(runtime, error)) {
          return;
        }
        consecutiveFailures += 1;
        const message = error instanceof Error ? error.message : "unknown error";
        this.#options.logger.warn(
          `[octo-mail] JMAP EventSource unavailable for Plugin Account ${runtime.config.pluginAccountId}; using Email/changes fallback: ${message}`,
        );
      }
      await abortableDelay(
        resolveDiscoveryDelayMs(
          runtime.config.discovery.pollIntervalMs,
          consecutiveFailures,
        ),
        signal,
      );
    }
  }

  async #pollAndLog(
    runtime: PluginAccountRuntime,
    poller: MailChangesPoller,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await poller.pollOnce(signal);
    if (result.emailsDispatched > 0) {
      this.#options.logger.info(
        `[octo-mail] dispatched ${result.emailsDispatched} Inbox email(s) for Plugin Account ${runtime.config.pluginAccountId}`,
      );
    }
  }

  #logPermanentStop(runtime: PluginAccountRuntime, error: unknown): boolean {
    const message = error instanceof Error ? error.message : "unknown error";
    if (error instanceof FatalDiscoveryError) {
      this.#options.logger.error(
        `[octo-mail] mail discovery stopped for Plugin Account ${runtime.config.pluginAccountId}: ${message}`,
      );
      return true;
    }
    if (
      error instanceof MailClientError &&
      (error.status === 401 || error.status === 403)
    ) {
      this.#options.logger.error(
        `[octo-mail] mail discovery stopped for Plugin Account ${runtime.config.pluginAccountId}: stored credential is invalid or revoked`,
      );
      return true;
    }
    return false;
  }

  async #stopAccount(pluginAccountId: string): Promise<void> {
    const active = this.#active.get(pluginAccountId);
    if (active === undefined) {
      return;
    }
    this.#active.delete(pluginAccountId);
    active.controller.abort(new Error("mail discovery stopped"));
    await active.loop;
  }
}

export function resolveDiscoveryDelayMs(
  pollIntervalMs: number,
  consecutiveFailures: number,
): number {
  if (consecutiveFailures <= 0) {
    return pollIntervalMs;
  }
  const exponent = Math.min(consecutiveFailures, 6);
  return Math.min(60_000, pollIntervalMs * 2 ** exponent);
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    timer.unref?.();
    signal.addEventListener("abort", finish, { once: true });
  });
}
