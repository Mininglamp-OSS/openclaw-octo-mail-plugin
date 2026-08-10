import type {
  PluginAccountRuntime,
  PluginAccountRuntimeRegistry,
} from "../accounts/account-runtime-registry.js";
import type { PluginAccountCatalog } from "../accounts/plugin-account.js";
import { PluginAccountRoutingError } from "../accounts/plugin-account.js";

export interface MailSessionBinding {
  sessionKey: string;
  eventId: string;
  pluginAccountId: string;
  agentId: string;
}

/** Durable implementation will live in the Plugin SQLite ledger. */
export interface MailSessionBindingStore {
  bind(binding: MailSessionBinding): Promise<"created" | "existing">;
  findBySessionKey(sessionKey: string): Promise<MailSessionBinding | undefined>;
}

export interface ResolveToolAccountOptions {
  agentId: string | undefined;
  sessionKey: string | undefined;
  catalog: PluginAccountCatalog;
  runtimes: PluginAccountRuntimeRegistry;
  bindings: MailSessionBindingStore;
}

/** Resolve a Tool call from trusted host context, never from model parameters. */
export async function resolveToolAccount(
  options: ResolveToolAccountOptions,
): Promise<PluginAccountRuntime> {
  const agentId = options.agentId?.trim();
  if (agentId === undefined || agentId.length === 0) {
    throw new PluginAccountRoutingError(
      "mail Tool requires a trusted OpenClaw agentId context",
    );
  }

  const sessionKey = options.sessionKey?.trim();
  if (sessionKey !== undefined && sessionKey.length > 0) {
    const binding = await options.bindings.findBySessionKey(sessionKey);
    if (binding !== undefined) {
      if (binding.agentId !== agentId) {
        throw new PluginAccountRoutingError(
          "mail session binding belongs to a different Agent",
        );
      }
      const account = options.catalog.getById(binding.pluginAccountId);
      if (!account.enabled || account.agentId !== agentId) {
        throw new PluginAccountRoutingError(
          "mail session binding does not match an enabled Agent/account route",
        );
      }
      return options.runtimes.getById(account.pluginAccountId);
    }
  }

  // Manual Agent sessions are safe only when agentId identifies one account.
  return options.runtimes.getSingleByAgentId(agentId);
}
