import { createHash } from "node:crypto";

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

import { normalizeOctoOrigin } from "../mail/octo-origin.js";
import {
  DEFAULT_PLUGIN_DISCOVERY_CONFIG,
  type PluginAccountConfig,
  type PluginAccountDiscoveryConfig,
} from "./plugin-account.js";

export interface PluginAccountDiscoveryIssue {
  agentId?: string;
  botId?: string;
  code:
    | "agent_missing"
    | "binding_implicit"
    | "binding_ambiguous"
    | "channel_account_missing"
    | "channel_account_invalid"
    | "channel_account_agent_mismatch"
    | "bot_reused";
  message: string;
}

export interface PluginAccountDiscoveryResult {
  accounts: PluginAccountConfig[];
  issues: PluginAccountDiscoveryIssue[];
}

interface Candidate {
  account: PluginAccountConfig;
  botIdentity: string;
}

/**
 * Derive all runtime mail accounts from trusted OpenClaw OCTO bindings.
 * Invalid mappings are excluded rather than guessed; one bad Bot does not
 * disable unrelated valid Agents.
 */
export function discoverPluginAccounts(
  config: OpenClawConfig,
  discoveryDefaults: PluginAccountDiscoveryConfig = DEFAULT_PLUGIN_DISCOVERY_CONFIG,
): PluginAccountDiscoveryResult {
  const issues: PluginAccountDiscoveryIssue[] = [];
  const knownAgents = new Set(
    (config.agents?.list ?? []).map((agent) => agent.id),
  );
  const bindingsByAgent = new Map<string, Array<string | undefined>>();
  for (const binding of config.bindings ?? []) {
    if (binding.match.channel !== "octo") {
      continue;
    }
    const ids = bindingsByAgent.get(binding.agentId) ?? [];
    ids.push(binding.match.accountId?.trim());
    bindingsByAgent.set(binding.agentId, ids);
  }

  const candidates: Candidate[] = [];
  for (const [agentId, rawAccountIds] of [...bindingsByAgent].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!knownAgents.has(agentId)) {
      issues.push({
        agentId,
        code: "agent_missing",
        message: `OCTO binding references missing Agent ${agentId}`,
      });
      continue;
    }
    if (
      rawAccountIds.some(
        (accountId) =>
          accountId === undefined || accountId.length === 0 || accountId === "*",
      )
    ) {
      issues.push({
        agentId,
        code: "binding_implicit",
        message: `Agent ${agentId} requires one explicit OCTO Bot binding`,
      });
      continue;
    }
    const botIds = [...new Set(rawAccountIds as string[])];
    if (botIds.length !== 1) {
      issues.push({
        agentId,
        code: "binding_ambiguous",
        message: `Agent ${agentId} has multiple OCTO Bot bindings`,
      });
      continue;
    }
    const botId = botIds[0]!;
    const channelAccount = readOctoChannelAccount(config, botId);
    if (channelAccount === undefined) {
      issues.push({
        agentId,
        botId,
        code: "channel_account_missing",
        message: `OCTO Bot account ${botId} is missing`,
      });
      continue;
    }
    const configuredAgentId = readOptionalString(channelAccount["agentId"]);
    if (
      configuredAgentId !== undefined &&
      configuredAgentId !== agentId
    ) {
      issues.push({
        agentId,
        botId,
        code: "channel_account_agent_mismatch",
        message: `OCTO Bot ${botId} is configured for another Agent`,
      });
      continue;
    }
    let apiBaseUrl: string;
    try {
      apiBaseUrl = readApiOrigin(channelAccount["apiUrl"]);
    } catch (error) {
      issues.push({
        agentId,
        botId,
        code: "channel_account_invalid",
        message: error instanceof Error ? error.message : "invalid OCTO apiUrl",
      });
      continue;
    }
    const botIdentity = `${apiBaseUrl}\n${botId}`;
    candidates.push({
      botIdentity,
      account: {
        pluginAccountId: stableBotAccountId(botIdentity, botId),
        enabled: true,
        agentId,
        botId,
        ...(readOptionalString(channelAccount["botProfile"]) === undefined
          ? {}
          : { botProfile: readOptionalString(channelAccount["botProfile"])! }),
        apiBaseUrl,
        discovery: { ...discoveryDefaults },
      },
    });
  }

  const ownersByBot = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const owners = ownersByBot.get(candidate.botIdentity) ?? [];
    owners.push(candidate);
    ownersByBot.set(candidate.botIdentity, owners);
  }
  const accounts: PluginAccountConfig[] = [];
  for (const candidate of candidates) {
    const owners = ownersByBot.get(candidate.botIdentity)!;
    if (owners.length !== 1) {
      if (owners[0] === candidate) {
        issues.push({
          botId: candidate.account.botId,
          code: "bot_reused",
          message: `OCTO Bot ${candidate.account.botId} is bound to multiple Agents`,
        });
      }
      continue;
    }
    accounts.push(candidate.account);
  }
  return { accounts, issues };
}

function readOctoChannelAccount(
  config: OpenClawConfig,
  botId: string,
): Record<string, unknown> | undefined {
  const channels = asRecord(config.channels);
  const octo = asRecord(channels?.["octo"]);
  const accounts = asRecord(octo?.["accounts"]);
  return asRecord(accounts?.[botId]);
}

function readApiOrigin(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("OCTO Bot apiUrl must be a non-empty string");
  }
  try {
    return normalizeOctoOrigin(new URL(value.trim()).origin);
  } catch (cause) {
    throw new Error("OCTO Bot apiUrl must be a valid HTTP(S) URL", { cause });
  }
}

function stableBotAccountId(identity: string, botId: string): string {
  const readable =
    botId
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "bot";
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  const readableBudget = 64 - "mail".length - digest.length - 2;
  return `mail_${readable.slice(0, readableBudget)}_${digest}`;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
