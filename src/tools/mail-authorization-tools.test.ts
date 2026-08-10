import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import { parseReliablePluginConfig } from "../accounts/plugin-account-config.js";
import { PluginAccountCatalog } from "../accounts/plugin-account.js";
import type { AgentMailAuthorizationService } from "../auth/agent-mail-authorization-service.js";
import {
  MAIL_CONNECTION_STATUS_TOOL_NAME,
  MAIL_CONNECT_TOOL_NAME,
} from "../constants.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";
import { createMailAuthorizationToolFactory } from "./mail-authorization-tools.js";

describe("Agent Mail authorization tools", () => {
  it("uses trusted agent routing and exposes no Bot/account selector", async () => {
    const start = vi.fn(async () => ({
      status: "authorization_required" as const,
      pluginAccountId: "support",
      userCode: "ABCD-EFGH",
      verificationUri:
        `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
      expiresAt: "2026-08-03T10:10:00.000Z",
      pollIntervalSeconds: 5,
    }));
    const service = { start, check: vi.fn() } as unknown as AgentMailAuthorizationService;
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([account("support", "mail-agent", "bot-support")]),
      getService: () => service,
      getConnectedMailboxAddress: () => undefined,
    });
    const tools = factory({ agentId: "mail-agent" } as OpenClawPluginToolContext);
    expect(Array.isArray(tools)).toBe(true);
    const list = tools as AnyAgentTool[];
    const connect = list.find((tool) => tool.name === MAIL_CONNECT_TOOL_NAME)!;

    expect(JSON.stringify(connect.parameters)).not.toMatch(
      /botId|botProfile|pluginAccountId/,
    );
    const result = await connect.execute(
      "call-1",
      { mailboxAddress: "support@example.test", spaceId: "space-support" },
      undefined,
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginAccountId: "support",
        botId: "bot-support",
      }),
      "support@example.test",
      "space-support",
      undefined,
    );
    expect(JSON.stringify(result)).not.toContain("deviceCode");
    expect(JSON.stringify(result)).not.toContain("codeVerifier");
    expect(JSON.stringify(result)).not.toContain("omb_");
  });

  it("completes authorization through the status tool", async () => {
    const check = vi.fn(async () => ({
      status: "connected" as const,
      pluginAccountId: "support",
      mailboxAddress: "support@example.test",
    }));
    const service = { start: vi.fn(), check } as unknown as AgentMailAuthorizationService;
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([account("support", "mail-agent", "bot-support")]),
      getService: () => service,
      getConnectedMailboxAddress: () => undefined,
    });
    const tools = factory({ agentId: "mail-agent" } as OpenClawPluginToolContext);
    const list = tools as AnyAgentTool[];
    const status = list.find(
      (tool) => tool.name === MAIL_CONNECTION_STATUS_TOOL_NAME,
    )!;

    const result = await status.execute("call-2", {}, undefined);

    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ pluginAccountId: "support" }),
      undefined,
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Agent Mail connected successfully: support@example.test",
    });
  });

  it("does not create another authorization when that mailbox is already connected", async () => {
    const service = {
      start: vi.fn(),
      check: vi.fn(),
    } as unknown as AgentMailAuthorizationService;
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([account("support", "mail-agent", "bot-support")]),
      getService: () => service,
      getConnectedMailboxAddress: () => "support@example.test",
    });
    const tools = factory({ agentId: "mail-agent" }) as AnyAgentTool[];
    const connect = tools.find(
      (tool) => tool.name === MAIL_CONNECT_TOOL_NAME,
    )!;

    const result = await connect.execute(
      "connect-existing",
      { mailboxAddress: "SUPPORT@example.test" },
      undefined,
    );

    expect(service.start).not.toHaveBeenCalled();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("already connected"),
    });
    expect(result.details).toMatchObject({
      status: "connected",
      mailboxAddress: "support@example.test",
      alreadyConnected: true,
    });
  });

  it("starts re-authorization only when replacement was explicitly requested", async () => {
    const start = vi.fn(async () => ({
      status: "authorization_required" as const,
      pluginAccountId: "support",
      userCode: "REAUTH-1",
      verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize?code=REAUTH-1`,
      expiresAt: "2026-08-03T10:10:00.000Z",
      pollIntervalSeconds: 5,
    }));
    const service = {
      start,
      check: vi.fn(),
    } as unknown as AgentMailAuthorizationService;
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([account("support", "mail-agent", "bot-support")]),
      getService: () => service,
      getConnectedMailboxAddress: () => "support@example.test",
    });
    const tools = factory({ agentId: "mail-agent" }) as AnyAgentTool[];
    const connect = tools.find(
      (tool) => tool.name === MAIL_CONNECT_TOOL_NAME,
    )!;

    await connect.execute(
      "reconnect-existing",
      {
        mailboxAddress: "support@example.test",
        spaceId: "space-support",
        replaceExisting: true,
      },
      undefined,
    );

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ pluginAccountId: "support" }),
      "support@example.test",
      "space-support",
      undefined,
    );
  });

  it("reports a credential-backed mailbox as connected without a pending device flow", async () => {
    const service = {
      start: vi.fn(),
      check: vi.fn(async () => ({
        status: "not_started" as const,
        pluginAccountId: "support",
      })),
    } as unknown as AgentMailAuthorizationService;
    const getConnectedMailboxAddress = vi.fn(
      () => "support@example.test",
    );
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([account("support", "mail-agent", "bot-support")]),
      getService: () => service,
      getConnectedMailboxAddress,
    });
    const tools = factory({ agentId: "mail-agent" }) as AnyAgentTool[];
    const status = tools.find(
      (tool) => tool.name === MAIL_CONNECTION_STATUS_TOOL_NAME,
    )!;

    const result = await status.execute("status-connected", {}, undefined);

    expect(getConnectedMailboxAddress).toHaveBeenCalledWith("support");
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "Agent Mail connected successfully: support@example.test",
    });
    expect(result.details).toEqual({
      status: "connected",
      pluginAccountId: "support",
      mailboxAddress: "support@example.test",
    });
  });

  it("waits for lazy runtime startup before using the authorization service", async () => {
    const service = {
      start: vi.fn(async () => ({
        status: "authorization_required" as const,
        pluginAccountId: "support",
        userCode: "ABCD-EFGH",
        verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
        expiresAt: "2026-08-03T10:10:00.000Z",
        pollIntervalSeconds: 5,
      })),
      check: vi.fn(),
    } as unknown as AgentMailAuthorizationService;
    const getService = vi.fn(async () => service);
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([account("support", "mail-agent", "bot-support")]),
      getService,
      getConnectedMailboxAddress: () => undefined,
    });
    const tools = factory({ agentId: "mail-agent" }) as AnyAgentTool[];
    const connect = tools.find(
      (tool) => tool.name === MAIL_CONNECT_TOOL_NAME,
    )!;

    await connect.execute(
      "call-lazy",
      { mailboxAddress: "support@example.test", spaceId: "space-support" },
      undefined,
    );

    expect(getService).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
  });

  it("does not expose onboarding tools when Agent routing is missing or ambiguous", () => {
    const service = {} as AgentMailAuthorizationService;
    const factory = createMailAuthorizationToolFactory({
      catalog: catalog([
        account("support", "mail-agent", "bot-support"),
        account("sales", "mail-agent", "bot-sales"),
      ]),
      getService: () => service,
      getConnectedMailboxAddress: () => undefined,
    });

    expect(factory({} as OpenClawPluginToolContext)).toBeNull();
    expect(
      factory({ agentId: "mail-agent" } as OpenClawPluginToolContext),
    ).toBeNull();
  });
});

function catalog(accounts: Record<string, unknown>[]): PluginAccountCatalog {
  return new PluginAccountCatalog(
    parseReliablePluginConfig({ accounts }).accounts,
  );
}

function account(
  pluginAccountId: string,
  agentId: string,
  botId: string,
): Record<string, unknown> {
  return {
    pluginAccountId,
    agentId,
    botId,
    apiBaseUrl: TEST_OCTO_ORIGIN,
    credentialRef: {
      source: "file",
      provider: `${pluginAccountId}_mail`,
      id: "value",
    },
  };
}
