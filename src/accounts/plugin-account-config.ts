import { parseAgentMailCredentialRef } from "../auth/secret-ref.js";
import { normalizeOctoOrigin } from "../mail/octo-origin.js";
import {
  DEFAULT_PLUGIN_DISCOVERY_CONFIG,
  type PluginAccountConfig,
  type PluginAccountDiscoveryConfig,
} from "./plugin-account.js";

const MAX_PLUGIN_ACCOUNTS = 32;
const ACCOUNT_KEYS = new Set([
  "pluginAccountId",
  "enabled",
  "agentId",
  "botId",
  "botProfile",
  "apiBaseUrl",
  "credentialRef",
  "discovery",
]);
const DISCOVERY_KEYS = new Set([
  "enabled",
  "pollIntervalMs",
  "maxChanges",
]);

export interface ReliablePluginConfig {
  accounts: PluginAccountConfig[];
}

export const reliablePluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["accounts"],
  properties: {
    accounts: {
      type: "array",
      minItems: 1,
      maxItems: MAX_PLUGIN_ACCOUNTS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "pluginAccountId",
          "agentId",
          "botId",
          "apiBaseUrl",
          "credentialRef",
        ],
        properties: {
          pluginAccountId: {
            type: "string",
            pattern: "^[a-z][a-z0-9_-]{0,63}$",
            minLength: 1,
            maxLength: 64,
          },
          enabled: { type: "boolean", default: true },
          agentId: { type: "string", minLength: 1, maxLength: 128 },
          botId: { type: "string", minLength: 1, maxLength: 256 },
          botProfile: { type: "string", minLength: 1, maxLength: 128 },
          apiBaseUrl: {
            type: "string",
            minLength: 1,
            description: "Public OCTO origin without credentials or path",
          },
          credentialRef: {
            type: "object",
            additionalProperties: false,
            required: ["source", "provider", "id"],
            properties: {
              source: { type: "string", enum: ["file"] },
              provider: {
                type: "string",
                pattern: "^[a-z][a-z0-9_-]{0,63}$",
                minLength: 1,
                maxLength: 64,
              },
              id: { type: "string", enum: ["value"] },
            },
          },
          discovery: {
            type: "object",
            additionalProperties: false,
            properties: {
              enabled: { type: "boolean", default: true },
              pollIntervalMs: {
                type: "integer",
                minimum: 1_000,
                maximum: 300_000,
                default: 5_000,
              },
              maxChanges: {
                type: "integer",
                minimum: 1,
                maximum: 1_000,
                default: 100,
              },
            },
          },
        },
      },
    },
  },
} as const;

export function parseReliablePluginConfig(
  value: unknown,
  discoveryDefaults: PluginAccountDiscoveryConfig = DEFAULT_PLUGIN_DISCOVERY_CONFIG,
): ReliablePluginConfig {
  if (!isRecord(value)) {
    throw new Error("octo-mail reliable plugin config must be an object");
  }
  const unknownTopLevel = Object.keys(value).filter((key) => key !== "accounts");
  if (unknownTopLevel.length > 0) {
    throw new Error(
      `octo-mail reliable plugin config contains unknown keys: ${unknownTopLevel.join(", ")}`,
    );
  }
  const rawAccounts = value["accounts"];
  if (
    !Array.isArray(rawAccounts) ||
    rawAccounts.length === 0 ||
    rawAccounts.length > MAX_PLUGIN_ACCOUNTS
  ) {
    throw new Error(
      `octo-mail reliable plugin config requires 1 to ${MAX_PLUGIN_ACCOUNTS} accounts`,
    );
  }

  const accounts = rawAccounts.map((raw, index) =>
    parseAccount(raw, index, discoveryDefaults),
  );
  assertUnique(
    accounts.map((account) => account.pluginAccountId),
    "pluginAccountId",
  );
  assertUnique(
    accounts.map((account) => secretRefKey(account.credentialRef!)),
    "credentialRef",
  );
  return { accounts };
}

function parseAccount(
  value: unknown,
  index: number,
  discoveryDefaults: PluginAccountDiscoveryConfig,
): PluginAccountConfig {
  const label = `octo-mail accounts[${index}]`;
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertKnownKeys(value, ACCOUNT_KEYS, label);

  const pluginAccountId = requireBoundedString(
    value["pluginAccountId"],
    `${label}.pluginAccountId`,
  );
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(pluginAccountId)) {
    throw new Error(
      `${label}.pluginAccountId must match /^[a-z][a-z0-9_-]{0,63}$/`,
    );
  }
  const agentId = requireBoundedString(value["agentId"], `${label}.agentId`);
  const botId = requireBoundedString(value["botId"], `${label}.botId`, 256);
  const botProfile = readOptionalBoundedString(
    value["botProfile"],
    `${label}.botProfile`,
    128,
  );
  const enabled = readBoolean(value["enabled"], `${label}.enabled`, true);
  const apiBaseUrl = normalizeApiOrigin(value["apiBaseUrl"], label);
  const credentialRef = parseAgentMailCredentialRef(value["credentialRef"]);
  if (credentialRef.source !== "file" || credentialRef.id !== "value") {
    throw new Error(
      `${label}.credentialRef must use the local MVP file/singleValue provider`,
    );
  }
  const discovery = parseDiscovery(
    value["discovery"],
    label,
    discoveryDefaults,
  );

  return {
    pluginAccountId,
    enabled,
    agentId,
    botId,
    ...(botProfile === undefined ? {} : { botProfile }),
    apiBaseUrl,
    credentialRef,
    discovery,
  };
}

function parseDiscovery(
  value: unknown,
  accountLabel: string,
  defaults: PluginAccountDiscoveryConfig,
): PluginAccountConfig["discovery"] {
  if (value === undefined) {
    return { ...defaults };
  }
  if (!isRecord(value)) {
    throw new Error(`${accountLabel}.discovery must be an object`);
  }
  assertKnownKeys(value, DISCOVERY_KEYS, `${accountLabel}.discovery`);
  return {
    enabled: readBoolean(
      value["enabled"],
      `${accountLabel}.discovery.enabled`,
      defaults.enabled,
    ),
    pollIntervalMs: readBoundedInteger(
      value["pollIntervalMs"],
      `${accountLabel}.discovery.pollIntervalMs`,
      1_000,
      300_000,
      defaults.pollIntervalMs,
    ),
    maxChanges: readBoundedInteger(
      value["maxChanges"],
      `${accountLabel}.discovery.maxChanges`,
      1,
      1_000,
      defaults.maxChanges,
    ),
  };
}

function normalizeApiOrigin(value: unknown, label: string): string {
  const raw = requireBoundedString(value, `${label}.apiBaseUrl`, 2_048);
  try {
    return normalizeOctoOrigin(raw);
  } catch (cause) {
    throw new Error(
      `${label}.apiBaseUrl must be a valid HTTP(S) origin without credentials, path, query, or fragment`,
      { cause },
    );
  }
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unknown keys: ${unknown.join(", ")}`);
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`octo-mail accounts contain duplicate ${label}: ${value}`);
    }
    seen.add(value);
  }
}

function secretRefKey(
  ref: NonNullable<PluginAccountConfig["credentialRef"]>,
): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxLength = 128,
): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${label} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function readBoolean(
  value: unknown,
  label: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

function readOptionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireBoundedString(value, label, maxLength);
}

function readBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  if (value === undefined) {
    return defaultValue;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
