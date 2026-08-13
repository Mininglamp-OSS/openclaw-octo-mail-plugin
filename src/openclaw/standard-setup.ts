import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

import { discoverPluginAccounts } from "../accounts/openclaw-account-discovery.js";
import {
  MAIL_AUTO_REPLY_TOOL_NAME,
  MAIL_CONNECTION_STATUS_TOOL_NAME,
  MAIL_CONNECT_TOOL_NAME,
  MAIL_GET_MESSAGE_TOOL_NAME,
  MAIL_REPLY_TOOL_NAME,
  MAIL_SEND_TOOL_NAME,
  PLUGIN_ID,
} from "../constants.js";

export const OCTO_MAIL_TOOL_NAMES = Object.freeze([
  MAIL_CONNECT_TOOL_NAME,
  MAIL_CONNECTION_STATUS_TOOL_NAME,
  MAIL_GET_MESSAGE_TOOL_NAME,
  MAIL_REPLY_TOOL_NAME,
  MAIL_SEND_TOOL_NAME,
  MAIL_AUTO_REPLY_TOOL_NAME,
]);

export interface StandardSetupResult {
  discoveredAccounts: number;
  mappingIssues: number;
}

/**
 * Enable the plugin once for the whole OpenClaw instance.
 * Agent/Bot mappings remain owned by standard OCTO bindings and are discovered
 * at Runtime, so adding another Bot never requires another mail setup command.
 */
export function configureStandardPlugin(
  draft: OpenClawConfig,
): StandardSetupResult {
  assertToolsNotGloballyDenied(draft);
  draft.plugins ??= {};
  draft.plugins.entries ??= {};
  const entry = draft.plugins.entries[PLUGIN_ID] ?? {};
  draft.plugins.entries[PLUGIN_ID] = {
    ...entry,
    enabled: true,
  };
  if (draft.plugins.allow !== undefined) {
    draft.plugins.allow = appendUnique(draft.plugins.allow, PLUGIN_ID);
  }

  draft.tools ??= {};
  draft.tools.alsoAllow = appendUnique(
    draft.tools.alsoAllow,
    ...OCTO_MAIL_TOOL_NAMES,
  );

  const discovery = discoverPluginAccounts(draft);
  return {
    discoveredAccounts: discovery.accounts.length,
    mappingIssues: discovery.issues.length,
  };
}

function assertToolsNotGloballyDenied(draft: OpenClawConfig): void {
  const expected = new Set(OCTO_MAIL_TOOL_NAMES);
  const denied = (draft.tools?.deny ?? []).filter((toolName) =>
    expected.has(toolName),
  );
  if (denied.length > 0) {
    throw new Error(
      `OpenClaw globally denies required mail tools: ${denied.join(", ")}`,
    );
  }
}

function appendUnique(
  current: readonly string[] | undefined,
  ...values: readonly string[]
): string[] {
  return [...new Set([...(current ?? []), ...values])];
}
