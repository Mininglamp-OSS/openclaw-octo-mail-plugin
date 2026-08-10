import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type { MailWorkflowStateStore } from "../runtime/mail-workflow-state-store.js";
import { OpenClawOwnerDraftNotifier } from "./owner-draft-notifier.js";

function notificationInput() {
  return {
    agentId: "support-agent",
    pluginAccountId: "mail_bot_support_hash",
    botId: "bot-support",
    mailboxAddress: "support@example.com",
    draft: {
      outcome: "owner_confirmation_required" as const,
      status: "pending_confirmation" as const,
      draftType: "agent_reply_draft" as const,
      draftId: "E-draft-1",
      draftSubject: "Re: Need help",
      draftVersion: 1,
      sourceEmailId: "E-source-1",
      threadId: "T-thread-1",
    },
    sourceMessage: {
      emailId: "E-source-1",
      threadId: "T-thread-1",
      mailboxIds: ["inbox"],
      from: [{ email: "customer@example.net" }],
      to: [{ email: "support@example.com" }],
      cc: [],
      subject: "Need help",
      preview: "Can you help?",
      hasAttachment: false,
    },
  };
}

function memoryState() {
  const delivered = new Set<string>();
  return {
    savePending: vi.fn(),
    getPending: vi.fn(),
    clearPending: vi.fn(),
    notificationDelivered: vi.fn(async (id: string) => delivered.has(id)),
    markNotificationDelivered: vi.fn(async (id: string) => {
      delivered.add(id);
    }),
  } satisfies MailWorkflowStateStore;
}

describe("OpenClaw owner Draft notifier", () => {
  it("targets the latest direct OCTO session for the exact Agent and Bot and notifies once", async () => {
    const state = memoryState();
    const sendText = vi.fn(async () => ({
      channel: "octo" as const,
      messageId: "notification-1",
    }));
    const loadAdapter = vi.fn(async () => ({ sendText }));
    const listSessionEntries = vi.fn(() => [
      {
        sessionKey: "agent:support-agent:octo:bot-other:direct:owner",
        entry: {
          chatType: "direct",
          updatedAt: 500,
          deliveryContext: {
            channel: "octo",
            to: "user:owner",
            accountId: "bot-other",
          },
        },
      },
      {
        sessionKey: "agent:support-agent:octo-mail-inbound-deadbeef",
        entry: {
          chatType: "direct",
          updatedAt: 400,
          deliveryContext: {
            channel: "octo",
            to: "user:owner",
            accountId: "bot-support",
          },
        },
      },
      {
        sessionKey: "agent:support-agent:octo:bot-support:group:room",
        entry: {
          chatType: "group",
          updatedAt: 300,
          deliveryContext: {
            channel: "octo",
            to: "group:room",
            accountId: "bot-support",
          },
        },
      },
      {
        sessionKey: "agent:support-agent:octo:bot-support:direct:owner-new",
        entry: {
          chatType: "direct",
          updatedAt: 200,
          deliveryContext: {
            channel: "octo",
            to: "user:owner-new",
            accountId: "bot-support",
          },
        },
      },
      {
        sessionKey: "agent:support-agent:octo:bot-support:direct:owner-old",
        entry: {
          chatType: "direct",
          updatedAt: 100,
          deliveryContext: {
            channel: "octo",
            to: "user:owner-old",
            accountId: "bot-support",
          },
        },
      },
    ]);
    const api = {
      config: {},
      runtime: {
        agent: { session: { listSessionEntries } },
        channel: { outbound: { loadAdapter } },
      },
    } as unknown as OpenClawPluginApi;
    const notifier = new OpenClawOwnerDraftNotifier({
      api,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await notifier.notifyReplyDraft(notificationInput());
    await notifier.notifyReplyDraft(notificationInput());

    expect(listSessionEntries).toHaveBeenCalledWith({
      agentId: "support-agent",
    });
    expect(loadAdapter).toHaveBeenCalledTimes(1);
    expect(loadAdapter).toHaveBeenCalledWith("octo");
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      cfg: {},
      to: "user:owner-new",
      text: expect.stringContaining("已生成回复草稿，尚未发送"),
      accountId: "bot-support",
    });
    expect(state.markNotificationDelivered).toHaveBeenCalledTimes(1);
  });

  it("does not mark a notification delivered when direct delivery fails", async () => {
    const state = memoryState();
    const api = {
      config: {},
      runtime: {
        agent: {
          session: {
            listSessionEntries: vi.fn(() => [
              {
                sessionKey:
                  "agent:support-agent:octo:bot-support:direct:owner",
                entry: {
                  chatType: "direct",
                  updatedAt: 100,
                  deliveryContext: {
                    channel: "octo",
                    to: "user:owner",
                    accountId: "bot-support",
                  },
                },
              },
            ]),
          },
        },
        channel: {
          outbound: {
            loadAdapter: vi.fn(async () => ({
              sendText: vi.fn(async () => {
                throw new Error("delivery failed");
              }),
            })),
          },
        },
      },
    } as unknown as OpenClawPluginApi;
    const notifier = new OpenClawOwnerDraftNotifier({
      api,
      state,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });

    await expect(
      notifier.notifyReplyDraft(notificationInput()),
    ).rejects.toThrow("delivery failed");
    expect(state.markNotificationDelivered).not.toHaveBeenCalled();
  });
});
