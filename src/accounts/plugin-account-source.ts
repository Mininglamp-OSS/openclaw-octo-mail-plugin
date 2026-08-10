import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

import type { PluginConfig } from "../config/plugin-config.js";
import {
  discoverPluginAccounts,
  type PluginAccountDiscoveryResult,
} from "./openclaw-account-discovery.js";

/** Explicit account config is retained only as a compatibility override. */
export function resolveRuntimePluginAccounts(
  config: OpenClawConfig,
  pluginConfig: PluginConfig,
): PluginAccountDiscoveryResult {
  if (pluginConfig.accounts.length > 0) {
    return { accounts: pluginConfig.accounts, issues: [] };
  }
  return discoverPluginAccounts(config, pluginConfig.discovery);
}
