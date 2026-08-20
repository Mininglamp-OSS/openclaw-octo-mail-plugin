import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

import {
  readPrivateAgentMailCredential,
  resolvePluginAccountCredentialTarget,
} from "../auth/private-credential-file.js";
import {
  resolveAgentMailCredential,
} from "../auth/secret-ref.js";
import { AgentMailApiClient } from "../mail/agent-mail-api-client.js";
import type {
  MailClient,
  MailDiscoveryClient,
  MailDraftDeliveryClient,
  MailIdentityClient,
} from "../mail/mail-client.js";
import { MailClientError } from "../mail/mail-client.js";
import type { PluginAccountCatalog, PluginAccountConfig } from "./plugin-account.js";
import { PluginAccountRoutingError } from "./plugin-account.js";

export type AccountMailClient = MailClient &
  MailDiscoveryClient &
  MailIdentityClient &
  MailDraftDeliveryClient;

export interface PluginAccountRuntime {
  config: PluginAccountConfig;
  client: AccountMailClient;
  mailboxAddress: string;
  mailAccountId: string;
  inboxMailboxId: string;
}

export interface AccountRuntimeStartContext {
  config: OpenClawConfig;
  stateDir: string;
  signal?: AbortSignal;
}

export interface AccountRuntimeRegistryDependencies {
  validateCredentialTarget?: (
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ) => void;
  resolveCredential?: (
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ) => Promise<string>;
  createClient?: (
    account: PluginAccountConfig,
    credential: string,
  ) => AccountMailClient;
  credentialExists?: (
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ) => Promise<boolean>;
  onAccountLoadError?: (
    account: PluginAccountConfig,
    error: unknown,
  ) => void;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const RATE_LIMIT_RETRY_DELAY_MS = 60_000;

/** Owns verified, in-memory clients without exposing credential values. */
export class PluginAccountRuntimeRegistry {
  readonly #catalog: PluginAccountCatalog;
  readonly #dependencies: Required<AccountRuntimeRegistryDependencies>;
  #runtimes: ReadonlyMap<string, PluginAccountRuntime> | undefined;
  #credentialFingerprints: ReadonlyMap<string, string> | undefined;
  readonly #activations = new Map<
    string,
    {
      credentialFingerprint: string;
      operation: Promise<PluginAccountRuntime>;
    }
  >();
  #starting = false;

  constructor(
    catalog: PluginAccountCatalog,
    dependencies: AccountRuntimeRegistryDependencies = {},
  ) {
    this.#catalog = catalog;
    this.#dependencies = {
      validateCredentialTarget:
        dependencies.validateCredentialTarget ?? defaultValidateCredentialTarget,
      resolveCredential:
        dependencies.resolveCredential ?? defaultResolveCredential,
      createClient: dependencies.createClient ?? defaultCreateClient,
      credentialExists:
        dependencies.credentialExists ?? defaultCredentialExists,
      onAccountLoadError:
        dependencies.onAccountLoadError ?? (() => undefined),
      sleep: dependencies.sleep ?? sleepWithSignal,
    };
  }

  async start(context: AccountRuntimeStartContext): Promise<void> {
    if (this.#runtimes !== undefined || this.#starting) {
      throw new Error("octo-mail account runtime registry already started");
    }
    this.#starting = true;
    try {
      const enabledAccounts = this.#catalog
        .listAll()
        .filter((account) => account.enabled);
      const loaded: Array<{
        runtime: PluginAccountRuntime;
        credentialFingerprint: string;
      }> = [];
      for (const account of enabledAccounts) {
        this.#dependencies.validateCredentialTarget(account, context);
        if (!(await this.#dependencies.credentialExists(account, context))) {
          continue;
        }
        const credential = await this.#dependencies.resolveCredential(
          account,
          context,
        );
        try {
          loaded.push({
            runtime: await this.#loadAccountWithRateLimitRetry(
              account,
              credential,
              context.signal,
            ),
            credentialFingerprint: fingerprintCredential(credential),
          });
        } catch (error) {
          if (isRejectedCredential(error)) {
            this.#dependencies.onAccountLoadError(account, error);
            continue;
          }
          throw error;
        }
      }
      const loadedRuntimes = loaded.map((item) => item.runtime);
      assertUniqueResolvedMailAccounts(loadedRuntimes);
      this.#runtimes = new Map(
        loadedRuntimes.map((runtime) => [
          runtime.config.pluginAccountId,
          runtime,
        ]),
      );
      this.#credentialFingerprints = new Map(
        loaded.map((item) => [
          item.runtime.config.pluginAccountId,
          item.credentialFingerprint,
        ]),
      );
    } finally {
      this.#starting = false;
    }
  }

  stop(): void {
    this.#runtimes = undefined;
    this.#credentialFingerprints = undefined;
    this.#activations.clear();
  }

  async activate(
    account: PluginAccountConfig,
    credential: string,
    signal?: AbortSignal,
  ): Promise<PluginAccountRuntime> {
    const credentialFingerprint = fingerprintCredential(credential);
    const currentOperation = this.#activations.get(account.pluginAccountId);
    if (currentOperation !== undefined) {
      if (
        currentOperation.credentialFingerprint === credentialFingerprint
      ) {
        return await currentOperation.operation;
      }
      try {
        await currentOperation.operation;
      } catch {
        // A different credential failed. Continue with the newer activation.
      }
      return await this.activate(account, credential, signal);
    }
    const operation = this.#activate(account, credential, signal);
    const activation = { credentialFingerprint, operation };
    this.#activations.set(account.pluginAccountId, activation);
    try {
      return await operation;
    } finally {
      if (this.#activations.get(account.pluginAccountId) === activation) {
        this.#activations.delete(account.pluginAccountId);
      }
    }
  }

  async #activate(
    account: PluginAccountConfig,
    credential: string,
    signal?: AbortSignal,
  ): Promise<PluginAccountRuntime> {
    const current = this.#requireStarted();
    const runtime = await this.#loadAccount(account, credential, signal);
    assertUniqueResolvedMailAccounts([
      ...[...current.values()].filter(
        (item) => item.config.pluginAccountId !== account.pluginAccountId,
      ),
      runtime,
    ]);
    this.#runtimes = new Map(current).set(account.pluginAccountId, runtime);
    this.#credentialFingerprints = new Map(
      this.#requireCredentialFingerprints(),
    ).set(account.pluginAccountId, fingerprintCredential(credential));
    return runtime;
  }

  async activateStored(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ): Promise<PluginAccountRuntime> {
    return await this.#activateStored(account, context);
  }

  async activateStoredIfFingerprintMatches(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
    expectedFingerprint: string,
  ): Promise<PluginAccountRuntime | undefined> {
    return await this.#activateStored(account, context, expectedFingerprint);
  }

  async getStoredCredentialFingerprint(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ): Promise<string | undefined> {
    this.#dependencies.validateCredentialTarget(account, context);
    if (!(await this.#dependencies.credentialExists(account, context))) {
      return undefined;
    }
    return fingerprintCredential(
      await this.#dependencies.resolveCredential(account, context),
    );
  }

  async #activateStored(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ): Promise<PluginAccountRuntime>;
  async #activateStored(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
    expectedFingerprint: string,
  ): Promise<PluginAccountRuntime | undefined>;
  async #activateStored(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
    expectedFingerprint?: string,
  ): Promise<PluginAccountRuntime | undefined> {
    this.#dependencies.validateCredentialTarget(account, context);
    if (!(await this.#dependencies.credentialExists(account, context))) {
      throw new PluginAccountRoutingError(
        `Plugin Account ${account.pluginAccountId} has no stored credential`,
      );
    }
    const credential = await this.#dependencies.resolveCredential(
      account,
      context,
    );
    const credentialFingerprint = fingerprintCredential(credential);
    if (
      expectedFingerprint !== undefined &&
      credentialFingerprint !== expectedFingerprint
    ) {
      return undefined;
    }
    const current = this.#requireStarted().get(account.pluginAccountId);
    if (
      current !== undefined &&
      this.#requireCredentialFingerprints().get(account.pluginAccountId) ===
        credentialFingerprint
    ) {
      return current;
    }
    return await this.activate(account, credential, context.signal);
  }

  getById(pluginAccountId: string): PluginAccountRuntime {
    const runtimes = this.#requireStarted();
    const runtime = runtimes.get(pluginAccountId);
    if (runtime === undefined) {
      throw new PluginAccountRoutingError(
        `Plugin Account ${pluginAccountId} has no active runtime`,
      );
    }
    return runtime;
  }

  listAll(): PluginAccountRuntime[] {
    return [...this.#requireStarted().values()];
  }

  getSingleByAgentId(agentId: string): PluginAccountRuntime {
    const account = this.#catalog.getSingleEnabledByAgentId(agentId);
    return this.getById(account.pluginAccountId);
  }

  async #loadAccount(
    account: PluginAccountConfig,
    credential: string,
    signal?: AbortSignal,
  ): Promise<PluginAccountRuntime> {
    const client = this.#dependencies.createClient(account, credential);
    // Keep authentication-bearing startup requests serial. A rejected
    // credential must consume one failed authentication attempt, not one per
    // identity/JMAP/Inbox request fired in parallel.
    const mailboxAddress = await client.getIdentityAddress(signal);
    const mailAccountId = await client.getMailAccountId(signal);
    const inboxMailboxId = await client.getInboxMailboxId(signal);
    return Object.freeze({
      config: account,
      client,
      mailboxAddress,
      mailAccountId,
      inboxMailboxId,
    });
  }

  async #loadAccountWithRateLimitRetry(
    account: PluginAccountConfig,
    credential: string,
    signal?: AbortSignal,
  ): Promise<PluginAccountRuntime> {
    try {
      return await this.#loadAccount(account, credential, signal);
    } catch (error) {
      if (!isRateLimited(error)) {
        throw error;
      }
      await this.#dependencies.sleep(RATE_LIMIT_RETRY_DELAY_MS, signal);
      return await this.#loadAccount(account, credential, signal);
    }
  }

  #requireStarted(): ReadonlyMap<string, PluginAccountRuntime> {
    if (this.#runtimes === undefined) {
      throw new PluginAccountRoutingError(
        "octo-mail account runtime registry is not started",
      );
    }
    return this.#runtimes;
  }

  #requireCredentialFingerprints(): ReadonlyMap<string, string> {
    if (this.#credentialFingerprints === undefined) {
      throw new PluginAccountRoutingError(
        "octo-mail account runtime registry is not started",
      );
    }
    return this.#credentialFingerprints;
  }
}

function fingerprintCredential(credential: string): string {
  return createHash("sha256").update(credential, "utf8").digest("hex");
}

function isRateLimited(error: unknown): boolean {
  return error instanceof MailClientError && error.code === "rate_limited";
}

async function sleepWithSignal(
  milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) {
    throw signal.reason ?? new Error("Plugin Account startup was aborted");
  }
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(signal?.reason ?? new Error("Plugin Account startup was aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout.unref?.();
  });
}

async function defaultCredentialExists(
  account: PluginAccountConfig,
  context: AccountRuntimeStartContext,
): Promise<boolean> {
  const target = resolvePluginAccountCredentialTarget({
    stateDir: context.stateDir,
    pluginAccountId: account.pluginAccountId,
    credentialRef: account.credentialRef,
    config: context.config,
  });
  try {
    await stat(target.filePath);
    return true;
  } catch (error) {
    if (isNodeNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function defaultValidateCredentialTarget(
  account: PluginAccountConfig,
  context: AccountRuntimeStartContext,
): void {
  resolvePluginAccountCredentialTarget({
    stateDir: context.stateDir,
    pluginAccountId: account.pluginAccountId,
    credentialRef: account.credentialRef,
    config: context.config,
  });
}

async function defaultResolveCredential(
  account: PluginAccountConfig,
  context: AccountRuntimeStartContext,
): Promise<string> {
  if (account.credentialRef !== undefined) {
    return await resolveAgentMailCredential({
      ref: account.credentialRef,
      config: context.config,
    });
  }
  const target = resolvePluginAccountCredentialTarget({
    stateDir: context.stateDir,
    pluginAccountId: account.pluginAccountId,
    config: context.config,
  });
  return readPrivateAgentMailCredential(target);
}

function defaultCreateClient(
  account: PluginAccountConfig,
  credential: string,
): AccountMailClient {
  return new AgentMailApiClient({
    baseUrl: account.apiBaseUrl,
    credential,
  });
}

function assertUniqueResolvedMailAccounts(
  runtimes: readonly PluginAccountRuntime[],
): void {
  const owners = new Map<string, string>();
  for (const runtime of runtimes) {
    const key = `${runtime.config.apiBaseUrl}\n${runtime.mailAccountId}`;
    const existing = owners.get(key);
    if (existing !== undefined) {
      throw new PluginAccountRoutingError(
        `Plugin Accounts ${existing} and ${runtime.config.pluginAccountId} resolve to the same mail account`,
      );
    }
    owners.set(key, runtime.config.pluginAccountId);
  }
}

function isNodeNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isRejectedCredential(error: unknown): boolean {
  return (
    error instanceof MailClientError &&
    (error.status === 401 || error.status === 403)
  );
}
