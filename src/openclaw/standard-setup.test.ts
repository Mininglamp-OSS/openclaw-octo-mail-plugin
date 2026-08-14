import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";

import {
  configureStandardPlugin,
  OCTO_MAIL_TOOL_NAMES,
} from "./standard-setup.js";
import { formatStandardStatus } from "./standard-cli.js";

describe("configureStandardPlugin", () => {
  it("enables mail tools once for every current and future OCTO Agent", () => {
    const config = createConfig();

    const result = configureStandardPlugin(config);

    expect(result).toEqual({ discoveredAccounts: 1, mappingIssues: 0 });
    expect(config.plugins?.entries?.["octo-mail"]?.enabled).toBe(true);
    expect(config.plugins?.entries?.["octo-mail"]?.hooks).toBeUndefined();
    expect(config.tools?.alsoAllow).toEqual(
      expect.arrayContaining([...OCTO_MAIL_TOOL_NAMES]),
    );
    expect(OCTO_MAIL_TOOL_NAMES).not.toContain("mail_confirm_send");
    expect(OCTO_MAIL_TOOL_NAMES).not.toContain("mail_cancel_send");
    expect(config.approvals?.plugin).toBeUndefined();
    expect(config.agents?.list?.[0]?.tools).toBeUndefined();
    expect(
      config.plugins?.entries?.["octo-mail"]?.config?.["accounts"],
    ).toBeUndefined();
  });

  it("is idempotent and does not create per-Agent configuration", () => {
    const config = createConfig();
    configureStandardPlugin(config);
    configureStandardPlugin(config);

    expect(config.tools?.alsoAllow).toHaveLength(OCTO_MAIL_TOOL_NAMES.length);
    expect(config.agents?.list?.every((agent) => agent.tools === undefined)).toBe(
      true,
    );
  });

  it("preserves an existing plugin allowlist", () => {
    const config = createConfig();
    config.plugins = { allow: ["octo"] };
    configureStandardPlugin(config);
    expect(config.plugins.allow).toEqual(["octo", "octo-mail"]);
  });

  it("preserves operator-defined plugin hook settings", () => {
    const config = createConfig();
    config.plugins = {
      entries: {
        "octo-mail": {
          enabled: false,
          hooks: {
            allowPromptInjection: false,
          },
        },
      },
    };

    configureStandardPlugin(config);

    expect(config.plugins.entries?.["octo-mail"]?.hooks).toEqual({
      allowPromptInjection: false,
    });
  });

  it("preserves an operator-defined plugin approval route", () => {
    const config = createConfig();
    config.approvals = {
      plugin: {
        enabled: true,
        mode: "targets",
        targets: [{ channel: "discord", to: "operator" }],
      },
    };

    configureStandardPlugin(config);

    expect(config.approvals.plugin).toEqual({
      enabled: true,
      mode: "targets",
      targets: [{ channel: "discord", to: "operator" }],
    });
  });

  it("does not override an explicit global deny", () => {
    const config = createConfig();
    config.tools = { deny: ["mail_reply"] };
    expect(() => configureStandardPlugin(config)).toThrow(
      /globally denies required mail tools: mail_reply/,
    );
  });

  it("reports dynamically discovered mappings without credentials", () => {
    const config = createConfig();
    configureStandardPlugin(config);
    const status = formatStandardStatus(config, "support-agent");
    expect(status).toContain("Tool policy: ready");
    expect(status).toContain("OCTO Bot: bot-support");
    expect(status).not.toContain("omb_");
    expect(status).not.toContain("credentialRef");
  });

  it("automatically includes a Bot added after initial setup", () => {
    const config = createConfig();
    configureStandardPlugin(config);
    config.agents!.list!.push({ id: "sales-agent" });
    config.bindings!.push({
      agentId: "sales-agent",
      match: { channel: "octo", accountId: "bot-sales" },
    });
    const octo = config.channels!["octo"] as {
      accounts: Record<string, unknown>;
    };
    octo.accounts["bot-sales"] = {
      agentId: "sales-agent",
      apiUrl: "https://octo.example.test/api",
    };

    const status = formatStandardStatus(config, "sales-agent");
    expect(status).toContain("OCTO Bot: bot-sales");
    expect(status).toContain("Tool policy: ready");
  });
});

function createConfig(): OpenClawConfig {
  return {
    agents: { list: [{ id: "support-agent" }] },
    bindings: [
      {
        agentId: "support-agent",
        match: { channel: "octo", accountId: "bot-support" },
      },
    ],
    channels: {
      octo: {
        accounts: {
          "bot-support": {
            agentId: "support-agent",
            apiUrl: "https://octo.example.test/api",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}
