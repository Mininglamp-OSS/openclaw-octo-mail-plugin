import {
  buildJsonPluginConfigSchema,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  parseReliablePluginConfig,
  reliablePluginConfigJsonSchema,
} from "../accounts/plugin-account-config.js";
import {
  DEFAULT_PLUGIN_DISCOVERY_CONFIG,
  type PluginAccountConfig,
  type PluginAccountDiscoveryConfig,
} from "../accounts/plugin-account.js";

const DISCOVERY_KEYS = new Set(["enabled", "pollIntervalMs", "maxChanges"]);

export interface PluginConfig {
  discovery: PluginAccountDiscoveryConfig;
  accounts: PluginAccountConfig[];
}

const discoveryConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      default: DEFAULT_PLUGIN_DISCOVERY_CONFIG.enabled,
      description:
        "Enable long-running JMAP discovery for automatically discovered Plugin Accounts",
    },
    pollIntervalMs: {
      type: "integer",
      minimum: 1_000,
      maximum: 300_000,
      default: DEFAULT_PLUGIN_DISCOVERY_CONFIG.pollIntervalMs,
      description:
        "Fallback Email/changes polling interval when JMAP EventSource is unavailable",
    },
    maxChanges: {
      type: "integer",
      minimum: 1,
      maximum: 1_000,
      default: DEFAULT_PLUGIN_DISCOVERY_CONFIG.maxChanges,
      description: "Maximum Email/changes records requested per page",
    },
  },
} as const;

export const pluginConfigJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    discovery: discoveryConfigJsonSchema,
    accounts: reliablePluginConfigJsonSchema.properties.accounts,
  },
} as const;

export const pluginConfigSchema: OpenClawPluginConfigSchema =
  buildJsonPluginConfigSchema(pluginConfigJsonSchema, {
    cacheKey: "octo-mail-plugin-config-v2",
  });

export function parsePluginConfig(value: unknown): PluginConfig {
  if (!isRecord(value)) {
    throw new Error("octo-mail plugin config must be an object");
  }

  const unknownKeys = Object.keys(value).filter(
    (key) => key !== "discovery" && key !== "accounts",
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `octo-mail plugin config contains unknown keys: ${unknownKeys.join(", ")}`,
    );
  }

  const discovery = parseDiscoveryConfig(value["discovery"]);
  const accounts =
    value["accounts"] === undefined
      ? []
      : parseReliablePluginConfig(
          { accounts: value["accounts"] },
          discovery,
        ).accounts;

  return { discovery, accounts };
}

function parseDiscoveryConfig(value: unknown): PluginAccountDiscoveryConfig {
  if (value === undefined) {
    return { ...DEFAULT_PLUGIN_DISCOVERY_CONFIG };
  }
  if (!isRecord(value)) {
    throw new Error("octo-mail plugin config discovery must be an object");
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !DISCOVERY_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `octo-mail plugin config discovery contains unknown keys: ${unknownKeys.join(", ")}`,
    );
  }
  return {
    enabled: readBoolean(
      value["enabled"],
      "octo-mail plugin config discovery.enabled",
      DEFAULT_PLUGIN_DISCOVERY_CONFIG.enabled,
    ),
    pollIntervalMs: readBoundedInteger(
      value["pollIntervalMs"],
      "octo-mail plugin config discovery.pollIntervalMs",
      1_000,
      300_000,
      DEFAULT_PLUGIN_DISCOVERY_CONFIG.pollIntervalMs,
    ),
    maxChanges: readBoundedInteger(
      value["maxChanges"],
      "octo-mail plugin config discovery.maxChanges",
      1,
      1_000,
      DEFAULT_PLUGIN_DISCOVERY_CONFIG.maxChanges,
    ),
  };
}

function readBoolean(
  value: unknown,
  label: string,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue;
  if (typeof value !== "boolean") {
    throw new Error(`${label} must be boolean`);
  }
  return value;
}

function readBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  defaultValue: number,
): number {
  if (value === undefined) return defaultValue;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}`,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
