import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
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
}

/** Owns verified, in-memory clients without exposing credential values. */
export class PluginAccountRuntimeRegistry {
  readonly #catalog: PluginAccountCatalog;
  readonly #dependencies: Required<AccountRuntimeRegistryDependencies>;
  #runtimes: ReadonlyMap<string, PluginAccountRuntime> | undefined;
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
      const candidates = await Promise.all(
        enabledAccounts.map(async (account) => {
          this.#dependencies.validateCredentialTarget(account, context);
          if (!(await this.#dependencies.credentialExists(account, context))) {
            return undefined;
          }
          const credential = await this.#dependencies.resolveCredential(
            account,
            context,
          );
          try {
            return await this.#loadAccount(account, credential, context.signal);
          } catch (error) {
            if (isRejectedCredential(error)) {
              this.#dependencies.onAccountLoadError(account, error);
              return undefined;
            }
            throw error;
          }
        }),
      );
      const loaded = candidates.filter(
        (runtime): runtime is PluginAccountRuntime => runtime !== undefined,
      );
      assertUniqueResolvedMailAccounts(loaded);
      this.#runtimes = new Map(
        loaded.map((runtime) => [runtime.config.pluginAccountId, runtime]),
      );
    } finally {
      this.#starting = false;
    }
  }

  stop(): void {
    this.#runtimes = undefined;
  }

  async activate(
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
    return runtime;
  }

  async activateStored(
    account: PluginAccountConfig,
    context: AccountRuntimeStartContext,
  ): Promise<PluginAccountRuntime> {
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
    const [mailboxAddress, mailAccountId, inboxMailboxId] = await Promise.all([
      client.getIdentityAddress(signal),
      client.getMailAccountId(signal),
      client.getInboxMailboxId(signal),
    ]);
    return Object.freeze({
      config: account,
      client,
      mailboxAddress,
      mailAccountId,
      inboxMailboxId,
    });
  }

  #requireStarted(): ReadonlyMap<string, PluginAccountRuntime> {
    if (this.#runtimes === undefined) {
      throw new PluginAccountRoutingError(
        "octo-mail account runtime registry is not started",
      );
    }
    return this.#runtimes;
  }
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
