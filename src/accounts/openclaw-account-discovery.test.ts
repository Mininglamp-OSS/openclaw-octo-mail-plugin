import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";

import { discoverPluginAccounts } from "./openclaw-account-discovery.js";

describe("discoverPluginAccounts", () => {
  it("derives isolated accounts for every unambiguous OCTO binding", () => {
    const result = discoverPluginAccounts(configWithTwoBots());
    expect(result.issues).toEqual([]);
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts.map((account) => account.agentId)).toEqual([
      "sales-agent",
      "support-agent",
    ]);
    expect(result.accounts[0]?.credentialRef).toBeUndefined();
    expect(result.accounts[0]?.pluginAccountId).not.toBe(
      result.accounts[1]?.pluginAccountId,
    );
  });

  it("applies configured discovery defaults to automatically discovered accounts", () => {
    const result = discoverPluginAccounts(configWithTwoBots(), {
      enabled: false,
      pollIntervalMs: 30_000,
      maxChanges: 250,
    });
    expect(result.accounts.map((account) => account.discovery)).toEqual([
      { enabled: false, pollIntervalMs: 30_000, maxChanges: 250 },
      { enabled: false, pollIntervalMs: 30_000, maxChanges: 250 },
    ]);
  });

  it("fails closed per Agent on wildcard and multiple bindings", () => {
    const config = configWithTwoBots();
    config.bindings = [
      {
        agentId: "support-agent",
        match: { channel: "octo", accountId: "*" },
      },
      {
        agentId: "sales-agent",
        match: { channel: "octo", accountId: "bot-sales" },
      },
      {
        agentId: "sales-agent",
        match: { channel: "octo", accountId: "bot-support" },
      },
    ];
    const result = discoverPluginAccounts(config);
    expect(result.accounts).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual([
      "binding_ambiguous",
      "binding_implicit",
    ]);
  });

  it("rejects one Bot identity reused by multiple Agents", () => {
    const config = configWithTwoBots();
    config.bindings![1]!.match.accountId = "bot-support";
    const octo = config.channels!["octo"] as {
      accounts: Record<string, Record<string, unknown>>;
    };
    delete octo.accounts["bot-support"]!["agentId"];
    const result = discoverPluginAccounts(config);
    expect(result.accounts).toEqual([]);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("bot_reused");
  });
});

function configWithTwoBots(): OpenClawConfig {
  return {
    agents: { list: [{ id: "support-agent" }, { id: "sales-agent" }] },
    bindings: [
      {
        agentId: "support-agent",
        match: { channel: "octo", accountId: "bot-support" },
      },
      {
        agentId: "sales-agent",
        match: { channel: "octo", accountId: "bot-sales" },
      },
    ],
    channels: {
      octo: {
        accounts: {
          "bot-support": {
            agentId: "support-agent",
            apiUrl: "https://octo.example.test/api",
          },
          "bot-sales": {
            agentId: "sales-agent",
            apiUrl: "https://octo.example.test/api",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}
