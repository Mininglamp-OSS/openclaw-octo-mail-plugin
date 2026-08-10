import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AccountMailClient } from "./account-runtime-registry.js";
import { PluginAccountRuntimeRegistry } from "./account-runtime-registry.js";
import { parseReliablePluginConfig } from "./plugin-account-config.js";
import { PluginAccountCatalog } from "./plugin-account.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";
import {
  resolvePluginAccountCredentialTarget,
  writePrivateAgentMailCredential,
} from "../auth/private-credential-file.js";
import { MailClientError } from "../mail/mail-client.js";

describe("Plugin Account runtime registry", () => {
  it("loads an auto-discovered Bot credential from plugin-owned private storage", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-runtime-"));
    const account = {
      pluginAccountId: "mail_bot_support_hash",
      enabled: true,
      agentId: "support-agent",
      botId: "bot-support",
      apiBaseUrl: TEST_OCTO_ORIGIN,
      discovery: { enabled: true, pollIntervalMs: 5_000, maxChanges: 100 },
    };
    const target = resolvePluginAccountCredentialTarget({
      stateDir,
      pluginAccountId: account.pluginAccountId,
      config: {} as OpenClawConfig,
    });
    await writePrivateAgentMailCredential(target, testCredential("auto"));
    const seenCredentials: string[] = [];
    const registry = new PluginAccountRuntimeRegistry(
      new PluginAccountCatalog([account]),
      {
        createClient: (_account, credential) => {
          seenCredentials.push(credential);
          return fakeClient("mail-support", "inbox-support");
        },
      },
    );

    await registry.start({ config: {} as OpenClawConfig, stateDir });

    expect(seenCredentials).toEqual([testCredential("auto")]);
    expect(registry.getSingleByAgentId("support-agent")).toMatchObject({
      mailAccountId: "mail-support",
    });
  });

  it("loads two isolated clients for one Agent without exposing credentials", async () => {
    const accounts = parseReliablePluginConfig({
      accounts: [
        accountInput("support", "mail-agent", "support_file"),
        accountInput("sales", "mail-agent", "sales_file"),
      ],
    }).accounts;
    const resolvedProviders: string[] = [];
    const registry = new PluginAccountRuntimeRegistry(
      new PluginAccountCatalog(accounts),
      {
        validateCredentialTarget: vi.fn(),
        credentialExists: vi.fn(async () => true),
        resolveCredential: vi.fn(async (account) => {
          resolvedProviders.push(account.credentialRef.provider);
          return testCredential(account.pluginAccountId);
        }),
        createClient: (account) =>
          fakeClient(`mail-${account.pluginAccountId}`, `inbox-${account.pluginAccountId}`),
      },
    );

    await registry.start({ config: {} as OpenClawConfig, stateDir: "/tmp/test" });

    expect(resolvedProviders).toEqual(["support_file", "sales_file"]);
    expect(registry.getById("support")).toMatchObject({
      mailAccountId: "mail-support",
      inboxMailboxId: "inbox-support",
    });
    expect(registry.getById("sales")).toMatchObject({
      mailAccountId: "mail-sales",
      inboxMailboxId: "inbox-sales",
    });
    expect(() => registry.getSingleByAgentId("mail-agent")).toThrow(
      /explicit account binding/,
    );
    expect(JSON.stringify(registry.getById("support"))).not.toContain("omb_");
  });

  it("fails startup atomically when two credentials resolve to one mail account", async () => {
    const accounts = parseReliablePluginConfig({
      accounts: [
        accountInput("support", "agent-a", "support_file"),
        accountInput("sales", "agent-b", "sales_file"),
      ],
    }).accounts;
    const registry = new PluginAccountRuntimeRegistry(
      new PluginAccountCatalog(accounts),
      {
        validateCredentialTarget: vi.fn(),
        credentialExists: vi.fn(async () => true),
        resolveCredential: vi.fn(async (account) =>
          testCredential(account.pluginAccountId),
        ),
        createClient: () => fakeClient("same-mail-account", "inbox"),
      },
    );

    await expect(
      registry.start({ config: {} as OpenClawConfig, stateDir: "/tmp/test" }),
    ).rejects.toThrow(/resolve to the same mail account/);
    expect(() => registry.getById("support")).toThrow(/not started/);
  });

  it("isolates a revoked credential without blocking other Plugin Accounts", async () => {
    const accounts = parseReliablePluginConfig({
      accounts: [
        accountInput("revoked", "agent-a", "revoked_file"),
        accountInput("healthy", "agent-b", "healthy_file"),
      ],
    }).accounts;
    const onAccountLoadError = vi.fn();
    const registry = new PluginAccountRuntimeRegistry(
      new PluginAccountCatalog(accounts),
      {
        validateCredentialTarget: vi.fn(),
        credentialExists: vi.fn(async () => true),
        resolveCredential: vi.fn(async (account) =>
          testCredential(account.pluginAccountId),
        ),
        createClient: (account) => {
          if (account.pluginAccountId === "revoked") {
            return {
              ...fakeClient("mail-revoked", "inbox-revoked"),
              getIdentityAddress: vi.fn(async () => {
                throw new MailClientError({
                  code: "unauthorized",
                  message: "revoked",
                  status: 401,
                });
              }),
            };
          }
          return fakeClient("mail-healthy", "inbox-healthy");
        },
        onAccountLoadError,
      },
    );

    await registry.start({ config: {} as OpenClawConfig, stateDir: "/tmp/test" });

    expect(() => registry.getById("revoked")).toThrow(/no active runtime/);
    expect(registry.getById("healthy")).toMatchObject({
      mailAccountId: "mail-healthy",
    });
    expect(onAccountLoadError).toHaveBeenCalledWith(
      expect.objectContaining({ pluginAccountId: "revoked" }),
      expect.objectContaining({ code: "unauthorized" }),
    );
  });

  it("clears active client references on stop", async () => {
    const account = parseReliablePluginConfig({
      accounts: [accountInput("support", "mail-agent", "support_file")],
    }).accounts;
    const registry = new PluginAccountRuntimeRegistry(
      new PluginAccountCatalog(account),
      {
        validateCredentialTarget: vi.fn(),
        credentialExists: vi.fn(async () => true),
        resolveCredential: vi.fn(async () => testCredential("support")),
        createClient: () => fakeClient("mail-support", "inbox"),
      },
    );
    await registry.start({ config: {} as OpenClawConfig, stateDir: "/tmp/test" });

    registry.stop();

    expect(() => registry.getById("support")).toThrow(/not started/);
  });

  it("starts with an unconnected account and activates it after authorization", async () => {
    const [account] = parseReliablePluginConfig({
      accounts: [accountInput("support", "mail-agent", "support_file")],
    }).accounts;
    const registry = new PluginAccountRuntimeRegistry(
      new PluginAccountCatalog([account!]),
      {
        validateCredentialTarget: vi.fn(),
        credentialExists: vi.fn(async () => false),
        resolveCredential: vi.fn(async () => {
          throw new Error("credential must not be resolved before onboarding");
        }),
        createClient: () => fakeClient("mail-support", "inbox"),
      },
    );
    await registry.start({ config: {} as OpenClawConfig, stateDir: "/tmp/test" });
    expect(() => registry.getById("support")).toThrow(/no active runtime/);

    await registry.activate(account!, testCredential("support"));

    expect(registry.getById("support")).toMatchObject({
      mailAccountId: "mail-support",
      inboxMailboxId: "inbox",
    });
  });
});

function fakeClient(
  mailAccountId: string,
  inboxMailboxId: string,
): AccountMailClient {
  return {
    getIdentityAddress: vi.fn(async () => `${mailAccountId}@example.test`),
    getMailAccountId: vi.fn(async () => mailAccountId),
    getInboxMailboxId: vi.fn(async () => inboxMailboxId),
    getCurrentEmailState: vi.fn(async () => "1"),
    getEmailChanges: vi.fn(async () => ({
      oldState: "1",
      newState: "1",
      hasMoreChanges: false,
      created: [],
      updated: [],
      destroyed: [],
    })),
    getMessages: vi.fn(async () => []),
    getAutoReplyContext: vi.fn(async () => ({
      enabled: false,
      autoReplyCount: 0,
      maxAutoReplyCount: 0,
      nextReplyIsFinal: false,
      limitReached: false,
    })),
    getMessage: vi.fn(async () => {
      throw new Error("not used");
    }),
    reply: vi.fn(async () => {
      throw new Error("not used");
    }),
    send: vi.fn(async () => {
      throw new Error("not used");
    }),
    replyAutomatically: vi.fn(async () => {
      throw new Error("not used");
    }),
    confirmDraft: vi.fn(async () => {
      throw new Error("not used");
    }),
  };
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

function testCredential(suffix: string): string {
  return ["omb", "runtime", suffix].join("_");
}
