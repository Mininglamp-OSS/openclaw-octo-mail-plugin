import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

import type { PluginAccountRuntimeRegistry } from "../accounts/account-runtime-registry.js";
import type { AgentMailAuthorizationService } from "../auth/agent-mail-authorization-service.js";

export interface AgentMailRuntimeStartContext {
  config: OpenClawConfig;
  stateDir: string;
  signal?: AbortSignal;
}

export interface AgentMailRuntimeControllerOptions {
  accountRuntimes: Pick<
    PluginAccountRuntimeRegistry,
    "start" | "stop"
  >;
  defaultContext: AgentMailRuntimeStartContext;
  createAuthorizationService: (
    context: AgentMailRuntimeStartContext,
  ) =>
    | AgentMailAuthorizationService
    | Promise<AgentMailAuthorizationService>;
  logStarted: () => void;
  logStopped: () => void;
  onRuntimesStarted?: (
    context: AgentMailRuntimeStartContext,
  ) => void | Promise<void>;
  onRuntimesStopping?: () => void | Promise<void>;
}

/**
 * Owns the authorization runtime across both Gateway service startup and a
 * first tool call. OpenClaw normally starts the registered service before any
 * tool executes; the lazy path closes lifecycle races without introducing a
 * second runtime or a host-specific bootstrap path.
 */
export class AgentMailRuntimeController {
  readonly #options: AgentMailRuntimeControllerOptions;
  #authorizationService: AgentMailAuthorizationService | undefined;
  #startPromise: Promise<AgentMailAuthorizationService> | undefined;
  #startController: AbortController | undefined;
  #stopPromise: Promise<void> | undefined;
  #runtimeResourcesStarted = false;

  constructor(options: AgentMailRuntimeControllerOptions) {
    this.#options = options;
  }

  async ensureStarted(
    context: AgentMailRuntimeStartContext = this.#options.defaultContext,
  ): Promise<AgentMailAuthorizationService> {
    if (this.#stopPromise !== undefined) {
      await this.#stopPromise;
    }
    if (this.#authorizationService !== undefined) {
      return this.#authorizationService;
    }
    if (this.#startPromise !== undefined) {
      return await this.#startPromise;
    }

    const controller = new AbortController();
    const abortFromContext = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted === true) {
      abortFromContext();
    } else {
      context.signal?.addEventListener("abort", abortFromContext, {
        once: true,
      });
    }
    const operation = this.#start({ ...context, signal: controller.signal });
    this.#startController = controller;
    this.#startPromise = operation;
    try {
      return await operation;
    } finally {
      context.signal?.removeEventListener("abort", abortFromContext);
      if (this.#startPromise === operation) {
        this.#startPromise = undefined;
      }
      if (this.#startController === controller) {
        this.#startController = undefined;
      }
    }
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
    this.#startController?.abort(
      new Error("Agent Mail runtime startup stopped"),
    );
    try {
      await this.#startPromise;
    } catch {
      // Startup already failed and performed its own cleanup.
    }
    if (
      this.#authorizationService === undefined &&
      !this.#runtimeResourcesStarted
    ) {
      return;
    }
    const wasStarted = this.#authorizationService !== undefined;
    await this.#authorizationService?.stop();
    this.#authorizationService = undefined;
    await this.#options.onRuntimesStopping?.();
    this.#options.accountRuntimes.stop();
    this.#runtimeResourcesStarted = false;
    if (wasStarted) {
      this.#options.logStopped();
    }
  }

  async #start(
    context: AgentMailRuntimeStartContext,
  ): Promise<AgentMailAuthorizationService> {
    try {
      await this.#options.accountRuntimes.start(context);
      this.#runtimeResourcesStarted = true;
      await this.#options.onRuntimesStarted?.(context);
      const service = await this.#options.createAuthorizationService(context);
      this.#authorizationService = service;
      this.#options.logStarted();
      return service;
    } catch (error) {
      await this.#options.onRuntimesStopping?.();
      this.#options.accountRuntimes.stop();
      this.#runtimeResourcesStarted = false;
      throw error;
    }
  }
}
