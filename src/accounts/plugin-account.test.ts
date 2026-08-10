import { describe, expect, it } from "vitest";

import {
  parseReliablePluginConfig,
  reliablePluginConfigJsonSchema,
} from "./plugin-account-config.js";
import {
  PluginAccountCatalog,
  PluginAccountRoutingError,
} from "./plugin-account.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";

describe("Reliable Plugin Account configuration", () => {
  it("normalizes one account with safe discovery defaults", () => {
    expect(
      parseReliablePluginConfig({
        accounts: [accountInput("support", "support-agent", "support_file")],
      }),
    ).toEqual({
      accounts: [
        {
          pluginAccountId: "support",
          enabled: true,
          agentId: "support-agent",
          botId: "bot-support",
          apiBaseUrl: TEST_OCTO_ORIGIN,
          credentialRef: {
            source: "file",
            provider: "support_file",
            id: "value",
          },
          discovery: {
            enabled: true,
            pollIntervalMs: 5_000,
            maxChanges: 100,
          },
        },
      ],
    });
  });

  it("allows two isolated accounts to target one Agent", () => {
    const config = parseReliablePluginConfig({
      accounts: [
        accountInput("support", "mail-agent", "support_file"),
        accountInput("sales", "mail-agent", "sales_file"),
      ],
    });
    const catalog = new PluginAccountCatalog(config.accounts);

    expect(catalog.getById("support").credentialRef!.provider).toBe(
      "support_file",
    );
    expect(catalog.getById("sales").credentialRef!.provider).toBe("sales_file");
    expect(catalog.listByAgentId("mail-agent")).toHaveLength(2);
    expect(() => catalog.getSingleEnabledByAgentId("mail-agent")).toThrow(
      /explicit account binding is required/,
    );
  });

  it("fails closed on duplicate account identity or SecretRef", () => {
    expect(() =>
      parseReliablePluginConfig({
        accounts: [
          accountInput("support", "agent-a", "support_file"),
          accountInput("support", "agent-b", "sales_file"),
        ],
      }),
    ).toThrow(/duplicate pluginAccountId/);

    expect(() =>
      parseReliablePluginConfig({
        accounts: [
          accountInput("support", "agent-a", "shared_file"),
          accountInput("sales", "agent-b", "shared_file"),
        ],
      }),
    ).toThrow(/duplicate credentialRef/);

    const parsed = parseReliablePluginConfig({
      accounts: [accountInput("support", "agent-a", "support_file")],
    }).accounts[0]!;
    expect(() =>
      new PluginAccountCatalog([
        parsed,
        { ...parsed, pluginAccountId: "sales", agentId: "agent-b" },
      ]),
    ).toThrow(/duplicate Plugin Account credentialRef/);
  });

  it("rejects literal credentials, unknown fields, and non-origin API URLs", () => {
    expect(() =>
      parseReliablePluginConfig({
        accounts: [
          {
            ...accountInput("support", "agent-a", "support_file"),
            credentialRef: "omb_nope",
          },
        ],
      }),
    ).toThrow(/structured OpenClaw SecretRef/);

    expect(() =>
      parseReliablePluginConfig({
        accounts: [
          {
            ...accountInput("support", "agent-a", "support_file"),
            profile: "legacy-cli-profile",
          },
        ],
      }),
    ).toThrow(/unknown keys: profile/);

    expect(() =>
      parseReliablePluginConfig({
        accounts: [
          {
            ...accountInput("support", "agent-a", "support_file"),
            apiBaseUrl: "https://octo.test/agent-mail-api",
          },
        ],
      }),
    ).toThrow(/origin without credentials/);

    expect(() =>
      parseReliablePluginConfig({
        accounts: [
          {
            ...accountInput("support", "agent-a", "support_file"),
            credentialRef: {
              source: "env",
              provider: "default",
              id: "OCTO_MAIL",
            },
          },
        ],
      }),
    ).toThrow(/file\/singleValue/);
  });

  it("keeps schema constraints aligned with parser limits", () => {
    expect(reliablePluginConfigJsonSchema.properties.accounts).toMatchObject({
      minItems: 1,
      maxItems: 32,
    });
  });

  it("fails agent-only routing for missing accounts", () => {
    const catalog = new PluginAccountCatalog(
      parseReliablePluginConfig({
        accounts: [
          {
            ...accountInput("support", "support-agent", "support_file"),
            enabled: false,
          },
        ],
      }).accounts,
    );

    expect(() => catalog.getSingleEnabledByAgentId("support-agent")).toThrow(
      PluginAccountRoutingError,
    );
  });
});

function accountInput(
  pluginAccountId: string,
  agentId: string,
  provider: string,
): Record<string, unknown> {
  return {
    pluginAccountId,
    agentId,
    botId: `bot-${pluginAccountId}`,
    apiBaseUrl: `${TEST_OCTO_ORIGIN}/`,
    credentialRef: { source: "file", provider, id: "value" },
  };
}
