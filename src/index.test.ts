import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawConfig,
  OpenClawPluginApi,
  OpenClawPluginService,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type { PluginAccountConfig } from "./accounts/plugin-account.js";
import {
  resolvePluginAccountCredentialTarget,
  writePrivateAgentMailCredential,
} from "./auth/private-credential-file.js";
import {
  MAIL_CONNECTION_STATUS_TOOL_NAME,
  MAIL_GET_MESSAGE_TOOL_NAME,
} from "./constants.js";
import plugin from "./index.js";
import { notifyCredentialActivation } from "./runtime/credential-activation-bus.js";
import {
  TEST_MAILBOX_ADDRESS,
  TEST_OCTO_ORIGIN,
} from "./testing/test-values.js";

const credential = "omb_test_prefix_secret";

describe("OCTO Agent Mail plugin registration", () => {
  it("recovers hot activation and starts inbound discovery on lazy use", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-index-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const config = {
      agents: { list: [] },
      bindings: [],
      channels: { octo: { accounts: {} } },
    } as OpenClawConfig;
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as PluginLogger;
    let service: OpenClawPluginService | undefined;
    const toolFactories: OpenClawPluginToolFactory[] = [];
    let promptHook:
      | ((
          event: unknown,
          context: { messageProvider?: string; agentId?: string },
        ) => { prependSystemContext: string } | undefined)
      | undefined;
    const api = {
      id: "octo-mail",
      name: "OCTO Agent Mail",
      source: "test",
      registrationMode: "full",
      config,
      pluginConfig: {},
      logger,
      runtime: {},
      registerCli: vi.fn(),
      registerTool(tool: unknown) {
        if (typeof tool === "function") {
          toolFactories.push(tool as OpenClawPluginToolFactory);
        }
      },
      registerService(candidate: OpenClawPluginService) {
        service = candidate;
      },
      on(name: string, handler: unknown) {
        if (name === "before_prompt_build") {
          promptHook = handler as typeof promptHook;
        }
      },
    } as unknown as OpenClawPluginApi;

    try {
      plugin.register?.(api);
      expect(service).toBeDefined();
      expect(promptHook).toBeDefined();
      await service!.start({ config, stateDir, logger });

      const before = promptHook!(undefined, {
        messageProvider: "octo",
        agentId: "support-agent",
      });
      expect(before?.prependSystemContext).toContain("not configured");

      const hotAccount = account();
      await writePrivateAgentMailCredential(
        resolvePluginAccountCredentialTarget({
          stateDir,
          pluginAccountId: hotAccount.pluginAccountId,
          credentialRef: hotAccount.credentialRef,
          config,
        }),
        credential,
      );
      let failInitialActivation = true;
      const fetchMock = vi.fn(
        async (target: string | URL | Request, init?: RequestInit) => {
          const url = String(target);
          if (url.endsWith("/agent-mail-api/webapi/v0/identity")) {
            if (failInitialActivation) {
              failInitialActivation = false;
              throw new TypeError("temporary activation failure");
            }
            return jsonResponse(200, { address: TEST_MAILBOX_ADDRESS });
          }
          if (url.endsWith("/agent-mail-api/.well-known/jmap")) {
            return jmapSession();
          }
          if (url.endsWith("/agent-mail-api/jmap/api")) {
            const request = JSON.parse(String(init?.body)) as {
              methodCalls: Array<[string, Record<string, unknown>, string]>;
            };
            const [method, args] = request.methodCalls[0]!;
            if (method === "Mailbox/get") {
              return jmapResponse(method, {
                accountId: "42",
                state: "10",
                list: [{ id: "mb-inbox", name: "Inbox", role: "inbox" }],
                notFound: [],
              });
            }
            if (method === "Email/get" && Array.isArray(args["ids"])) {
              const ids = args["ids"] as string[];
              return jmapResponse(method, {
                accountId: "42",
                state: "10",
                list: ids.map((emailId) => message(emailId)),
                notFound: [],
              });
            }
          }
          if (url.endsWith("/agent-mail-api/webapi/v0/messages/E7")) {
            return jsonResponse(200, { id: "E7" });
          }
          if (url.includes("/agent-mail-api/jmap/eventsource")) {
            return await waitForAbort(init?.signal);
          }
          throw new Error(`unexpected test request: ${url}`);
        },
      );
      vi.stubGlobal("fetch", fetchMock);

      await notifyCredentialActivation(hotAccount);

      const after = promptHook!(undefined, {
        messageProvider: "octo",
        agentId: "support-agent",
      });
      expect(after?.prependSystemContext).toContain("dedicated OCTO Agent Mail");
      expect(after?.prependSystemContext).not.toContain("not configured");
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining("failed to activate newly stored credential"),
      );
      expect(logger.info).not.toHaveBeenCalledWith(
        expect.stringContaining("mail discovery started"),
      );

      const tools = toolFactories.flatMap(
        (factory) =>
          factory({ agentId: "support-agent" } as OpenClawPluginToolContext) ??
          [],
      );
      const getMessageTool = tools.find(
        (tool) => tool.name === MAIL_GET_MESSAGE_TOOL_NAME,
      );
      expect(getMessageTool).toBeDefined();
      const messageResult = (await getMessageTool!.execute(
        "get-message-call",
        { emailId: "E7" },
        undefined,
      )) as { details: unknown };
      expect(messageResult.details).toMatchObject({ emailId: "E7" });
      await vi.waitFor(() =>
        expect(logger.info).toHaveBeenCalledWith(
          expect.stringContaining("mail discovery started"),
        ),
      );

      const statusTool = tools.find(
        (tool) => tool.name === MAIL_CONNECTION_STATUS_TOOL_NAME,
      );
      expect(statusTool).toBeDefined();
      const status = (await statusTool!.execute(
        "status-call",
        {},
        undefined,
      )) as { details: unknown };
      expect(status.details).toEqual({
        status: "connected",
        pluginAccountId: hotAccount.pluginAccountId,
        mailboxAddress: TEST_MAILBOX_ADDRESS,
      });
    } finally {
      await service?.stop?.({ config, stateDir, logger });
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

function account(): PluginAccountConfig {
  const botId = "support-bot";
  const digest = createHash("sha256")
    .update(`${TEST_OCTO_ORIGIN}\n${botId}`)
    .digest("hex")
    .slice(0, 12);
  return {
    pluginAccountId: `mail_${botId}_${digest}`,
    enabled: true,
    agentId: "support-agent",
    botId,
    apiBaseUrl: TEST_OCTO_ORIGIN,
    discovery: { enabled: true, pollIntervalMs: 5_000, maxChanges: 100 },
  };
}

function message(emailId: string): Record<string, unknown> {
  return {
    id: emailId,
    threadId: "T3",
    mailboxIds: { "mb-inbox": true },
    receivedAt: "2026-08-19T10:00:00.000Z",
    from: [{ name: "Alice", email: "alice@example.test" }],
    to: [{ email: TEST_MAILBOX_ADDRESS }],
    cc: [],
    subject: "Hello",
    preview: "Plain body",
    bodyStructure: { type: "text/plain", partId: "1" },
    bodyValues: { "1": { value: "Plain body", isTruncated: false } },
    hasAttachment: false,
  };
}

async function waitForAbort(signal?: AbortSignal | null): Promise<Response> {
  return await new Promise<Response>((_resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}

function jmapResponse(method: string, body: unknown): Response {
  return jsonResponse(200, {
    methodResponses: [[method, body, "octo-mail-plugin"]],
  });
}

function jmapSession(): Response {
  return jsonResponse(200, {
    capabilities: {
      "urn:ietf:params:jmap:core": {},
      "urn:ietf:params:jmap:mail": {},
    },
    primaryAccounts: { "urn:ietf:params:jmap:mail": "42" },
    apiUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/api`,
    eventSourceUrl: `${TEST_OCTO_ORIGIN}/agent-mail-api/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
