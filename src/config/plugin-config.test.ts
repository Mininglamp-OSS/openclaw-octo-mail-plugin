import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { parsePluginConfig, pluginConfigJsonSchema } from "./plugin-config.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";

describe("parsePluginConfig", () => {
  it("applies production discovery defaults to an unconfigured plugin", () => {
    expect(parsePluginConfig({})).toEqual({
      discovery: {
        enabled: true,
        pollIntervalMs: 5_000,
        maxChanges: 100,
      },
      accounts: [],
    });
  });

  it("accepts bounded production discovery defaults", () => {
    expect(
      parsePluginConfig({
        discovery: {
          enabled: false,
          pollIntervalMs: 15_000,
          maxChanges: 250,
        },
      }),
    ).toEqual({
      discovery: {
        enabled: false,
        pollIntervalMs: 15_000,
        maxChanges: 250,
      },
      accounts: [],
    });
  });

  it("rejects removed POC configuration", () => {
    expect(() =>
      parsePluginConfig({
        agentId: "support-agent",
        pocMailMode: "live",
        pocDiscoveryEnabled: true,
      }),
    ).toThrow(/unknown keys/);
  });

  it("rejects invalid or unknown discovery configuration", () => {
    expect(() =>
      parsePluginConfig({ discovery: { pollIntervalMs: 999 } }),
    ).toThrow(/1000 to 300000/);
    expect(() =>
      parsePluginConfig({ discovery: { retryForever: true } }),
    ).toThrow(/unknown keys/);
  });

  it("uses top-level discovery values for legacy accounts without overrides", () => {
    expect(
      parsePluginConfig({
        discovery: { pollIntervalMs: 12_000, maxChanges: 50 },
        accounts: [
          {
            pluginAccountId: "support",
            agentId: "support-agent",
            botId: "bot-support",
            apiBaseUrl: TEST_OCTO_ORIGIN,
            credentialRef: {
              source: "file",
              provider: "support_mail",
              id: "value",
            },
          },
        ],
      }),
    ).toMatchObject({
      accounts: [
        {
          botId: "bot-support",
          discovery: {
            enabled: true,
            pollIntervalMs: 12_000,
            maxChanges: 50,
          },
        },
      ],
    });
  });

  it("keeps per-account discovery overrides authoritative", () => {
    expect(
      parsePluginConfig({
        discovery: { pollIntervalMs: 12_000, maxChanges: 50 },
        accounts: [
          {
            pluginAccountId: "support",
            agentId: "support-agent",
            botId: "bot-support",
            apiBaseUrl: TEST_OCTO_ORIGIN,
            credentialRef: {
              source: "file",
              provider: "support_mail",
              id: "value",
            },
            discovery: { pollIntervalMs: 2_000, maxChanges: 10 },
          },
        ],
      }),
    ).toMatchObject({
      accounts: [
        {
          discovery: {
            enabled: true,
            pollIntervalMs: 2_000,
            maxChanges: 10,
          },
        },
      ],
    });
  });

  it("keeps the runtime and manifest config schemas aligned", () => {
    const manifest = JSON.parse(
      readFileSync("openclaw.plugin.json", "utf8"),
    ) as { configSchema?: unknown };

    expect(manifest.configSchema).toEqual(pluginConfigJsonSchema);
  });
});
