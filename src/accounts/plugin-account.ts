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

/** Immutable indexes over already validated Plugin Account configuration. */
export class PluginAccountCatalog {
  readonly #byId: ReadonlyMap<string, PluginAccountConfig>;
  readonly #byAgentId: ReadonlyMap<string, readonly PluginAccountConfig[]>;

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

function freezeAccount(account: PluginAccountConfig): PluginAccountConfig {
  return Object.freeze({
    ...account,
    ...(account.credentialRef === undefined
      ? {}
      : { credentialRef: Object.freeze({ ...account.credentialRef }) }),
    discovery: Object.freeze({ ...account.discovery }),
  });
}
