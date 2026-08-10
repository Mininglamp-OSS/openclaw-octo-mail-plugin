import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import {
  resolvePluginAccountCredentialTarget,
  writePrivateAgentMailCredential,
} from "./private-credential-file.js";
import {
  AgentMailAuthorizationClient,
  AgentMailAuthorizationError,
  type AgentMailboxCredential,
} from "./agent-mail-authorization-client.js";
import {
  createPendingAuthorization,
  type PendingAgentAuthorization,
  type PendingAuthorizationStore,
  PrivatePendingAuthorizationStore,
} from "./pending-authorization-store.js";
import { createPkcePair, type PkcePair } from "./pkce.js";

export interface AgentMailAuthorizationServiceOptions {
  config: OpenClawConfig;
  stateDir: string;
  pendingStore?: PendingAuthorizationStore;
  createClient?: (account: PluginAccountConfig) => AgentMailAuthorizationClient;
  createPkce?: () => PkcePair;
  storeCredential?: (
    account: PluginAccountConfig,
    credential: string,
  ) => Promise<void>;
  onCredentialStored?: (
    account: PluginAccountConfig,
    credential: string,
  ) => void | Promise<void>;
  now?: () => Date;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onBackgroundError?: (
    account: PluginAccountConfig,
    error: unknown,
  ) => void;
}

export interface AuthorizationRequiredResult {
  status: "authorization_required";
  pluginAccountId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalSeconds: number;
}

export type AuthorizationStatusResult =
  | {
      status: "pending";
      pluginAccountId: string;
      userCode: string;
      verificationUri: string;
      expiresAt: string;
      pollIntervalSeconds: number;
    }
  | {
      status: "connected";
      pluginAccountId: string;
      mailboxAddress: string;
    }
  | {
      status: "expired" | "denied" | "used" | "not_started";
      pluginAccountId: string;
    };

/** Coordinates device authorization without exposing device proof or omb_. */
export class AgentMailAuthorizationService {
  readonly #options: Required<
    Pick<
      AgentMailAuthorizationServiceOptions,
      | "pendingStore"
      | "createClient"
      | "createPkce"
      | "storeCredential"
      | "onCredentialStored"
      | "now"
      | "sleep"
      | "onBackgroundError"
    >
  >;
  readonly #backgroundTasks = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  readonly #checks = new Map<string, Promise<AuthorizationStatusResult>>();
  readonly #connected = new Map<string, AuthorizationStatusResult>();
  #stopped = false;

  constructor(options: AgentMailAuthorizationServiceOptions) {
    const pendingStore =
      options.pendingStore ??
      new PrivatePendingAuthorizationStore(options.stateDir);
    this.#options = {
      pendingStore,
      createClient:
        options.createClient ??
        ((account) =>
          new AgentMailAuthorizationClient({ baseUrl: account.apiBaseUrl })),
      createPkce: options.createPkce ?? createPkcePair,
      storeCredential:
        options.storeCredential ??
        (async (account, credential) => {
          const target = resolvePluginAccountCredentialTarget({
            stateDir: options.stateDir,
            pluginAccountId: account.pluginAccountId,
            credentialRef: account.credentialRef,
            config: options.config,
          });
          await writePrivateAgentMailCredential(target, credential);
        }),
      onCredentialStored: options.onCredentialStored ?? (() => undefined),
      now: options.now ?? (() => new Date()),
      sleep: options.sleep ?? abortableSleep,
      onBackgroundError: options.onBackgroundError ?? (() => undefined),
    };
  }

  async start(
    account: PluginAccountConfig,
    mailboxAddress: string,
    spaceId: string,
    signal?: AbortSignal,
  ): Promise<AuthorizationRequiredResult> {
    this.#assertRunning();
    assertEnabledAccount(account);
    const requestedMailboxAddress = mailboxAddress.trim();
    const requestedSpaceId = normalizeSpaceId(spaceId);
    const existingPending = await this.#options.pendingStore.load(
      account.pluginAccountId,
    );
    if (existingPending !== undefined) {
      assertPendingMatchesAccount(existingPending, account);
      const stillValid =
        Date.parse(existingPending.expiresAt) > this.#options.now().getTime();
      if (
        stillValid &&
        sameMailboxAddress(
          existingPending.requestedMailboxAddress,
          requestedMailboxAddress,
        ) && existingPending.spaceId === requestedSpaceId
      ) {
        this.#startBackgroundTask(account);
        return publicPendingResult("authorization_required", existingPending);
      }
      if (!stillValid) {
        await this.#options.pendingStore.delete(account.pluginAccountId);
      }
    }
    await this.#cancelBackgroundTask(account.pluginAccountId);
    const pkce = this.#options.createPkce();
    const client = this.#options.createClient(account);
    const createdAt = this.#options.now();
    const device = await client.createDeviceAuthorization(
      {
        botId: account.botId,
        ...(account.botProfile === undefined
          ? {}
          : { botProfile: account.botProfile }),
        mailboxAddress: requestedMailboxAddress,
        spaceId: requestedSpaceId,
        codeChallenge: pkce.challenge,
      },
      signal,
    );
    const expiresAt = new Date(
      createdAt.getTime() + device.expiresIn * 1_000,
    );
    const pending = createPendingAuthorization({
      pluginAccountId: account.pluginAccountId,
      botId: account.botId,
      ...(account.botProfile === undefined
        ? {}
        : { botProfile: account.botProfile }),
      deviceCode: device.deviceCode,
      codeVerifier: pkce.verifier,
      userCode: device.userCode,
      verificationUriComplete: device.verificationUriComplete,
      requestedMailboxAddress,
      spaceId: requestedSpaceId,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      intervalSeconds: device.interval,
    });
    await this.#options.pendingStore.save(pending);
    this.#startBackgroundTask(account);
    return publicPendingResult("authorization_required", pending);
  }

  async check(
    account: PluginAccountConfig,
    signal?: AbortSignal,
  ): Promise<AuthorizationStatusResult> {
    this.#assertRunning();
    assertEnabledAccount(account);
    const existing = this.#checks.get(account.pluginAccountId);
    if (existing !== undefined) {
      return await existing;
    }
    const operation = this.#checkOnce(account, signal);
    this.#checks.set(account.pluginAccountId, operation);
    try {
      return await operation;
    } finally {
      if (this.#checks.get(account.pluginAccountId) === operation) {
        this.#checks.delete(account.pluginAccountId);
      }
    }
  }

  /** Resume secure pending proofs after a normal Runtime restart. */
  async resumePending(accounts: readonly PluginAccountConfig[]): Promise<void> {
    this.#assertRunning();
    await Promise.all(
      accounts
        .filter((account) => account.enabled)
        .map(async (account) => {
          const pending = await this.#options.pendingStore.load(
            account.pluginAccountId,
          );
          if (pending === undefined) {
            return;
          }
          assertPendingMatchesAccount(pending, account);
          this.#startBackgroundTask(account);
        }),
    );
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const tasks = [...this.#backgroundTasks.values()];
    for (const task of tasks) {
      task.controller.abort(new Error("Agent Mail runtime stopped"));
    }
    await Promise.allSettled(tasks.map((task) => task.promise));
    this.#backgroundTasks.clear();
    this.#checks.clear();
  }

  async #checkOnce(
    account: PluginAccountConfig,
    signal?: AbortSignal,
  ): Promise<AuthorizationStatusResult> {
    const pending = await this.#options.pendingStore.load(
      account.pluginAccountId,
    );
    if (pending === undefined) {
      return (
        this.#connected.get(account.pluginAccountId) ?? {
          status: "not_started",
          pluginAccountId: account.pluginAccountId,
        }
      );
    }
    assertPendingMatchesAccount(pending, account);
    if (Date.parse(pending.expiresAt) <= this.#options.now().getTime()) {
      await this.#options.pendingStore.delete(account.pluginAccountId);
      return { status: "expired", pluginAccountId: account.pluginAccountId };
    }

    let credential: AgentMailboxCredential;
    try {
      credential = await this.#options
        .createClient(account)
        .exchangeAuthorization(
          {
            deviceCode: pending.deviceCode,
            codeVerifier: pending.codeVerifier,
          },
          signal,
        );
    } catch (error) {
      if (
        error instanceof AgentMailAuthorizationError &&
        error.code === "authorization_pending"
      ) {
        return publicPendingResult("pending", pending);
      }
      const terminalStatus = terminalAuthorizationStatus(error);
      if (terminalStatus !== undefined) {
        await this.#options.pendingStore.delete(account.pluginAccountId);
        return {
          status: terminalStatus,
          pluginAccountId: account.pluginAccountId,
        };
      }
      throw error;
    }

    try {
      assertCredentialIdentity(account, credential);
    } catch (error) {
      await this.#options.pendingStore.delete(account.pluginAccountId);
      throw error;
    }
    await this.#options.storeCredential(account, credential.accessToken);
    await this.#options.onCredentialStored(account, credential.accessToken);
    await this.#options.pendingStore.delete(account.pluginAccountId);
    const connected: AuthorizationStatusResult = {
      status: "connected",
      pluginAccountId: account.pluginAccountId,
      mailboxAddress: credential.mailboxAddress,
    };
    this.#connected.set(account.pluginAccountId, connected);
    return connected;
  }

  #startBackgroundTask(account: PluginAccountConfig): void {
    if (this.#backgroundTasks.has(account.pluginAccountId)) {
      return;
    }
    const controller = new AbortController();
    const promise = this.#pollUntilComplete(account, controller.signal).finally(
      () => {
        const current = this.#backgroundTasks.get(account.pluginAccountId);
        if (current?.promise === promise) {
          this.#backgroundTasks.delete(account.pluginAccountId);
        }
      },
    );
    this.#backgroundTasks.set(account.pluginAccountId, {
      controller,
      promise,
    });
  }

  async #pollUntilComplete(
    account: PluginAccountConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const initial = await this.#options.pendingStore.load(account.pluginAccountId);
    if (initial === undefined) {
      return;
    }
    try {
      await this.#options.sleep(initial.intervalSeconds * 1_000, signal);
    } catch (error) {
      if (!signal.aborted) {
        this.#options.onBackgroundError(account, error);
      }
      return;
    }
    while (!signal.aborted) {
      let result: AuthorizationStatusResult;
      try {
        result = await this.check(account, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.#options.onBackgroundError(account, error);
        }
        return;
      }
      if (result.status !== "pending") {
        return;
      }
      try {
        await this.#options.sleep(
          result.pollIntervalSeconds * 1_000,
          signal,
        );
      } catch (error) {
        if (!signal.aborted) {
          this.#options.onBackgroundError(account, error);
        }
        return;
      }
    }
  }

  async #cancelBackgroundTask(pluginAccountId: string): Promise<void> {
    const task = this.#backgroundTasks.get(pluginAccountId);
    if (task === undefined) {
      return;
    }
    task.controller.abort(new Error("Agent Mail authorization restarted"));
    await task.promise;
  }

  #assertRunning(): void {
    if (this.#stopped) {
      throw new Error("Agent Mail authorization service is stopped");
    }
  }
}

function sameMailboxAddress(
  left: string | undefined,
  right: string,
): boolean {
  return left?.trim().toLowerCase() === right.toLowerCase();
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timeout.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function publicPendingResult<
  TStatus extends "authorization_required" | "pending",
>(
  status: TStatus,
  pending: PendingAgentAuthorization,
): {
  status: TStatus;
  pluginAccountId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalSeconds: number;
} {
  return {
    status,
    pluginAccountId: pending.pluginAccountId,
    userCode: pending.userCode,
    verificationUri: pending.verificationUriComplete,
    expiresAt: pending.expiresAt,
    pollIntervalSeconds: pending.intervalSeconds,
  };
}

function assertEnabledAccount(account: PluginAccountConfig): void {
  if (!account.enabled) {
    throw new Error("Agent Mail authorization requires an enabled Plugin Account");
  }
}

function normalizeSpaceId(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error("Agent Mail spaceId must contain 1 to 200 characters");
  }
  return normalized;
}

function assertPendingMatchesAccount(
  pending: PendingAgentAuthorization,
  account: PluginAccountConfig,
): void {
  if (
    pending.botId !== account.botId ||
    pending.botProfile !== account.botProfile
  ) {
    throw new Error(
      "Agent Mail pending authorization does not match the Plugin Account Bot identity",
    );
  }
}

function assertCredentialIdentity(
  account: PluginAccountConfig,
  credential: AgentMailboxCredential,
): void {
  if (credential.botId !== account.botId) {
    throw new Error(
      "Agent Mail authorization was issued for another Bot",
    );
  }
  if (
    account.botProfile !== undefined &&
    credential.botProfile !== account.botProfile
  ) {
    throw new Error(
      "Agent Mail authorization was issued for another Bot profile",
    );
  }
}

function terminalAuthorizationStatus(
  error: unknown,
): "expired" | "denied" | "used" | undefined {
  if (!(error instanceof AgentMailAuthorizationError)) {
    return undefined;
  }
  if (error.code === "authorization_expired") {
    return "expired";
  }
  if (error.code === "authorization_denied") {
    return "denied";
  }
  if (error.code === "authorization_used") {
    return "used";
  }
  return undefined;
}
