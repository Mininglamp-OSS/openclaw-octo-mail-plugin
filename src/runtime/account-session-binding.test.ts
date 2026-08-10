import { describe, expect, it, vi } from "vitest";

import type { PluginAccountRuntimeRegistry } from "../accounts/account-runtime-registry.js";
import { parseReliablePluginConfig } from "../accounts/plugin-account-config.js";
import { PluginAccountCatalog } from "../accounts/plugin-account.js";
import {
  resolveToolAccount,
  type MailSessionBindingStore,
} from "./account-session-binding.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";

describe("mail Tool account routing", () => {
  it("uses a durable session binding when one Agent owns two accounts", async () => {
    const catalog = catalogForTwoAccounts();
    const supportRuntime = { config: catalog.getById("support") };
    const runtimes = {
      getById: vi.fn(() => supportRuntime),
      getSingleByAgentId: vi.fn(() => {
        throw new Error("ambiguous");
      }),
    } as unknown as PluginAccountRuntimeRegistry;
    const bindings: MailSessionBindingStore = {
      bind: vi.fn(async (): Promise<"created"> => "created"),
      findBySessionKey: vi.fn(async () => ({
        sessionKey: "agent:mail-agent:session-1",
        eventId: "event-1",
        pluginAccountId: "support",
        agentId: "mail-agent",
      })),
    };

    await expect(
      resolveToolAccount({
        agentId: "mail-agent",
        sessionKey: "agent:mail-agent:session-1",
        catalog,
        runtimes,
        bindings,
      }),
    ).resolves.toBe(supportRuntime);
    expect(runtimes.getById).toHaveBeenCalledWith("support");
  });

  it("fails closed when a binding is replayed under another Agent", async () => {
    const catalog = catalogForTwoAccounts();
    const runtimes = {
      getById: vi.fn(),
      getSingleByAgentId: vi.fn(),
    } as unknown as PluginAccountRuntimeRegistry;
    const bindings: MailSessionBindingStore = {
      bind: vi.fn(async (): Promise<"created"> => "created"),
      findBySessionKey: vi.fn(async () => ({
        sessionKey: "session-1",
        eventId: "event-1",
        pluginAccountId: "support",
        agentId: "mail-agent",
      })),
    };

    await expect(
      resolveToolAccount({
        agentId: "other-agent",
        sessionKey: "session-1",
        catalog,
        runtimes,
        bindings,
      }),
    ).rejects.toThrow(/different Agent/);
    expect(runtimes.getById).not.toHaveBeenCalled();
  });

  it("allows an unbound manual session only for one unambiguous account", async () => {
    const config = parseReliablePluginConfig({
      accounts: [accountInput("support", "mail-agent", "support_file")],
    });
    const catalog = new PluginAccountCatalog(config.accounts);
    const runtime = { config: catalog.getById("support") };
    const runtimes = {
      getById: vi.fn(),
      getSingleByAgentId: vi.fn(() => runtime),
    } as unknown as PluginAccountRuntimeRegistry;
    const bindings: MailSessionBindingStore = {
      bind: vi.fn(async (): Promise<"created"> => "created"),
      findBySessionKey: vi.fn(async () => undefined),
    };

    await expect(
      resolveToolAccount({
        agentId: "mail-agent",
        sessionKey: "manual-session",
        catalog,
        runtimes,
        bindings,
      }),
    ).resolves.toBe(runtime);
  });
});

function catalogForTwoAccounts(): PluginAccountCatalog {
  return new PluginAccountCatalog(
    parseReliablePluginConfig({
      accounts: [
        accountInput("support", "mail-agent", "support_file"),
        accountInput("sales", "mail-agent", "sales_file"),
      ],
    }).accounts,
  );
}

function accountInput(
  pluginAccountId: string,
  agentId: string,
  provider: string,
): Record<string, unknown> {
  return {
    pluginAccountId,
    agentId,
    botId: `bot-${pluginAccountId}`,
    apiBaseUrl: TEST_OCTO_ORIGIN,
    credentialRef: { source: "file", provider, id: "value" },
  };
}
