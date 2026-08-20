import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

export interface PluginAccountDiscoveryConfig {
  enabled: boolean;
  pollIntervalMs: number;
  maxChanges: number;
}

export const DEFAULT_PLUGIN_DISCOVERY_CONFIG: Readonly<PluginAccountDiscoveryConfig> =
  Object.freeze({
    enabled: true,
    pollIntervalMs: 5_000,
    maxChanges: 100,
  });

export interface PluginAccountConfig {
  pluginAccountId: string;
  enabled: boolean;
  agentId: string;
  botId: string;
  botProfile?: string;
  apiBaseUrl: string;
  /**
   * Explicit legacy configuration may point at an OpenClaw SecretRef.
   * Auto-discovered OCTO Bot accounts omit it and use the plugin-owned private
   * credential file keyed by the trusted Bot identity.
   */
  credentialRef?: SecretRef;
  discovery: PluginAccountDiscoveryConfig;
}

export class PluginAccountRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginAccountRoutingError";
  }
}

/** Validated indexes over trusted Plugin Account configuration. */
export class PluginAccountCatalog {
  #byId: ReadonlyMap<string, PluginAccountConfig>;
  #byAgentId: ReadonlyMap<string, readonly PluginAccountConfig[]>;

  constructor(accounts: readonly PluginAccountConfig[]) {
    const byId = new Map<string, PluginAccountConfig>();
    const byAgentId = new Map<string, PluginAccountConfig[]>();
    const credentialRefs = new Set<string>();
    for (const account of accounts) {
      if (byId.has(account.pluginAccountId)) {
        throw new PluginAccountRoutingError(
          `duplicate Plugin Account id: ${account.pluginAccountId}`,
        );
      }
      if (account.credentialRef !== undefined) {
        const credentialRef = `${account.credentialRef.source}:${account.credentialRef.provider}:${account.credentialRef.id}`;
        if (credentialRefs.has(credentialRef)) {
          throw new PluginAccountRoutingError(
            `duplicate Plugin Account credentialRef: ${credentialRef}`,
          );
        }
        credentialRefs.add(credentialRef);
      }
      const frozen = freezeAccount(account);
      byId.set(frozen.pluginAccountId, frozen);
      if (frozen.enabled) {
        const agentAccounts = byAgentId.get(frozen.agentId) ?? [];
        agentAccounts.push(frozen);
        byAgentId.set(frozen.agentId, agentAccounts);
      }
    }
    this.#byId = byId;
    this.#byAgentId = new Map(
      [...byAgentId].map(([agentId, agentAccounts]) => [
        agentId,
        Object.freeze([...agentAccounts]),
      ]),
    );
  }

  getById(pluginAccountId: string): PluginAccountConfig {
    const account = this.#byId.get(pluginAccountId);
    if (account === undefined) {
      throw new PluginAccountRoutingError(
        `unknown Plugin Account: ${pluginAccountId}`,
      );
    }
    return account;
  }

  listAll(): readonly PluginAccountConfig[] {
    return [...this.#byId.values()];
  }

  listByAgentId(agentId: string): readonly PluginAccountConfig[] {
    return this.#byAgentId.get(agentId) ?? [];
  }

  /**
   * Add an account discovered by another registration context in this Gateway.
   * Existing ids must remain semantically equivalent so a credential event
   * cannot silently retarget an already trusted runtime binding.
   */
  register(account: PluginAccountConfig): PluginAccountConfig {
    const existing = this.#byId.get(account.pluginAccountId);
    if (existing !== undefined) {
      if (!samePluginAccountConfig(existing, account)) {
        throw new PluginAccountRoutingError(
          `Plugin Account ${account.pluginAccountId} changed configuration; a Gateway reload is required`,
        );
      }
      return existing;
    }

    const replacement = new PluginAccountCatalog([
      ...this.#byId.values(),
      account,
    ]);
    this.#byId = replacement.#byId;
    this.#byAgentId = replacement.#byAgentId;
    return this.getById(account.pluginAccountId);
  }

  getSingleEnabledByAgentId(agentId: string): PluginAccountConfig {
    const accounts = this.listByAgentId(agentId);
    if (accounts.length === 0) {
      throw new PluginAccountRoutingError(
        `Agent ${agentId} has no enabled Plugin Account`,
      );
    }
    if (accounts.length !== 1) {
      throw new PluginAccountRoutingError(
        `Agent ${agentId} has multiple Plugin Accounts; an explicit account binding is required`,
      );
    }
    return accounts[0]!;
  }
}

function samePluginAccountConfig(
  left: PluginAccountConfig,
  right: PluginAccountConfig,
): boolean {
  return (
    left.pluginAccountId === right.pluginAccountId &&
    left.enabled === right.enabled &&
    left.agentId === right.agentId &&
    left.botId === right.botId &&
    left.botProfile === right.botProfile &&
    left.apiBaseUrl === right.apiBaseUrl &&
    sameCredentialRef(left.credentialRef, right.credentialRef) &&
    left.discovery.enabled === right.discovery.enabled &&
    left.discovery.pollIntervalMs === right.discovery.pollIntervalMs &&
    left.discovery.maxChanges === right.discovery.maxChanges
  );
}

function sameCredentialRef(
  left: SecretRef | undefined,
  right: SecretRef | undefined,
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.source === right.source &&
      left.provider === right.provider &&
      left.id === right.id)
  );
}

function freezeAccount(account: PluginAccountConfig): PluginAccountConfig {
  return Object.freeze({
    ...account,
    ...(account.credentialRef === undefined
      ? {}
      : { credentialRef: Object.freeze({ ...account.credentialRef }) }),
    discovery: Object.freeze({ ...account.discovery }),
  });
}
