import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type {
  PluginAccountRuntime,
  PluginAccountRuntimeRegistry,
} from "../accounts/account-runtime-registry.js";
import { parseReliablePluginConfig } from "../accounts/plugin-account-config.js";
import {
  PluginAccountCatalog,
  PluginAccountRoutingError,
} from "../accounts/plugin-account.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";
import type {
  MailWorkflowStateStore,
  PendingMailConfirmation,
} from "../runtime/mail-workflow-state-store.js";
import { createAccountMailToolFactory } from "./account-mail-tools.js";

describe("account-aware Mail Tool factory", () => {
  it("exposes tools before startup and resolves the account client lazily", async () => {
    const catalog = accountCatalog();
    const send = vi.fn(async () => ({
      outcome: "accepted" as const,
      messageId: "sent-1",
      submissionIds: ["submission-1"],
      senderAddress: "support@mail.imocto.cn",
    }));
    const runtime = {
      config: catalog.getById("support"),
      client: { send },
      mailboxAddress: "support@example.test",
      mailAccountId: "mail-support",
      inboxMailboxId: "inbox",
    };
    const runtimes = {
      getById: vi.fn(() => runtime),
    } as unknown as PluginAccountRuntimeRegistry;
    const ensureRuntimeStarted = vi.fn(async () => undefined);
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes,
      ensureRuntimeStarted,
      activateStoredRuntime: vi.fn(
        async () => runtime as unknown as PluginAccountRuntime,
      ),
    });

    const tools = factory({
      agentId: "mail-agent",
    } as OpenClawPluginToolContext);

    expect(Array.isArray(tools)).toBe(true);
    expect((tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual([
      "mail_get_message",
      "mail_reply",
      "mail_send",
    ]);
    expect(ensureRuntimeStarted).not.toHaveBeenCalled();
    expect(runtimes.getById).not.toHaveBeenCalled();

    const sendTool = (tools as AnyAgentTool[]).find(
      (tool) => tool.name === "mail_send",
    )!;
    expect(sendTool.description).toContain("Draft");
    expect(sendTool.description).toContain("automatic-send mode");
    expect(sendTool.description).toContain("structured Tool result");
    expect(sendTool.description).toContain("确认发送");
    const result = await sendTool.execute(
      "send-1",
      {
        to: ["recipient@example.test"],
        subject: "Hello",
        body: "World",
      },
      undefined,
    );

    expect(ensureRuntimeStarted).toHaveBeenCalledTimes(1);
    expect(runtimes.getById).toHaveBeenCalledWith("support");
    expect(send).toHaveBeenCalledWith(
      {
        to: ["recipient@example.test"],
        subject: "Hello",
        text: "World",
      },
      undefined,
      "mail-send:send-1",
    );
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining(
        "发件邮箱：support@mail.imocto.cn",
      ),
    });
    expect(result.details).toMatchObject({
      senderAddress: "support@mail.imocto.cn",
      to: ["recipient@example.test"],
      subject: "Hello",
      realEmailSent: true,
    });
  });

  it("returns a policy Draft as a normal not-sent tool result", async () => {
    const catalog = accountCatalog();
    const send = vi.fn(async () => ({
      outcome: "owner_review_required" as const,
      status: "pending_confirmation" as const,
      draftId: "E42",
      draftSubject: "Payment plan",
      draftVersion: 1,
      policyVersion: "local-keyword-v1-test",
      reasons: [
        {
          code: "configured_review_term",
          title: "需要人工确认",
          description: "涉及付款信息",
        },
      ],
      source: "owner_direct" as const,
    }));
    const runtime = {
      config: catalog.getById("support"),
      client: { send },
      mailboxAddress: "support@example.test",
      mailAccountId: "mail-support",
      inboxMailboxId: "inbox",
    };
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes: {
        getById: vi.fn(() => runtime),
      } as unknown as PluginAccountRuntimeRegistry,
      ensureRuntimeStarted: vi.fn(async () => undefined),
      activateStoredRuntime: vi.fn(
        async () => runtime as unknown as PluginAccountRuntime,
      ),
    });
    const tools = factory({ agentId: "mail-agent" }) as AnyAgentTool[];
    const result = await tools
      .find((tool) => tool.name === "mail_send")!
      .execute(
        "send-policy-1",
        {
          to: ["recipient@example.test"],
          subject: "Payment plan",
          body: "Please review",
        },
        undefined,
      );

    expect(result.content).toEqual([
      {
        type: "text",
        text: expect.stringContaining("邮件未发送"),
      },
    ]);
    expect(result.details).toMatchObject({
      outcome: "owner_review_required",
      draftId: "E42",
      realEmailSent: false,
    });
  });

  it("keeps tools visible for one unconnected account and fails with onboarding guidance", async () => {
    const catalog = accountCatalog();
    const runtimes = {
      getById: vi.fn(() => {
        throw new PluginAccountRoutingError("not connected");
      }),
    } as unknown as PluginAccountRuntimeRegistry;
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes,
      ensureRuntimeStarted: vi.fn(async () => undefined),
      activateStoredRuntime: vi.fn(async () => {
        throw new PluginAccountRoutingError("no stored credential");
      }),
    });

    const tools = factory({
      agentId: "mail-agent",
    } as OpenClawPluginToolContext) as AnyAgentTool[];
    const sendTool = tools.find((tool) => tool.name === "mail_send")!;
    await expect(
      sendTool.execute(
        "send-unconnected",
        {
          to: ["recipient@example.test"],
          subject: "Hello",
          body: "World",
        },
        undefined,
      ),
    ).rejects.toMatchObject({
      code: "mailbox_not_connected",
      message: expect.stringContaining("current Agent"),
    });
  });

  it("refreshes a newly stored credential when the tool context has stale account state", async () => {
    const catalog = accountCatalog();
    const send = vi.fn(async () => ({
      outcome: "accepted" as const,
      messageId: "sent-after-refresh",
      submissionIds: ["submission-refresh"],
    }));
    const refreshedRuntime = {
      config: catalog.getById("support"),
      client: { send },
      mailboxAddress: "support@example.test",
      mailAccountId: "mail-support",
      inboxMailboxId: "inbox",
    };
    const runtimes = {
      getById: vi.fn(() => {
        throw new PluginAccountRoutingError("stale registry");
      }),
    } as unknown as PluginAccountRuntimeRegistry;
    const activateStoredRuntime = vi.fn(
      async () => refreshedRuntime as unknown as PluginAccountRuntime,
    );
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes,
      ensureRuntimeStarted: vi.fn(async () => undefined),
      activateStoredRuntime,
    });
    const tools = factory({ agentId: "mail-agent" }) as AnyAgentTool[];
    const sendTool = tools.find((tool) => tool.name === "mail_send")!;

    await sendTool.execute(
      "send-after-refresh",
      {
        to: ["recipient@example.test"],
        subject: "Hello",
        body: "World",
      },
      undefined,
    );

    expect(activateStoredRuntime).toHaveBeenCalledWith("support");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("exposes scoped auto-reply only to host-created inbound mail sessions", () => {
    const catalog = accountCatalog();
    const runtimes = {
      getSingleByAgentId: vi.fn(() => ({
        config: catalog.getById("support"),
        client: {},
        mailAccountId: "mail-support",
        inboxMailboxId: "inbox",
      })),
      getById: vi.fn(() => ({
        config: catalog.getById("support"),
        client: {},
        mailboxAddress: "support@example.test",
        mailAccountId: "mail-support",
        inboxMailboxId: "inbox",
      })),
    } as unknown as PluginAccountRuntimeRegistry;
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes,
      ensureRuntimeStarted: vi.fn(async () => undefined),
      activateStoredRuntime: vi.fn(async () =>
        runtimes.getById("support"),
      ),
    });

    const tools = factory({
      agentId: "mail-agent",
      sessionKey: "agent:mail-agent:octo-mail-inbound-deadbeef",
    } as OpenClawPluginToolContext) as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain("mail_auto_reply");

    const normal = factory({
      agentId: "mail-agent",
      sessionKey: "agent:mail-agent:normal-chat",
    } as OpenClawPluginToolContext) as Array<{ name: string }>;
    expect(normal.map((tool) => tool.name)).not.toContain("mail_auto_reply");
  });

  it("persists a prepared Draft and confirms only the saved session version", async () => {
    const catalog = accountCatalog("MyBot");
    const send = vi.fn(async () => ({
      outcome: "owner_confirmation_required" as const,
      status: "pending_confirmation" as const,
      draftType: "agent_pending_confirmation" as const,
      draftId: "E55",
      draftSubject: "Hello",
      senderAddress: "support@example.test",
      draftVersion: 1,
    }));
    const sendPreparedDraft = vi.fn(async () => ({
      outcome: "accepted" as const,
      messageId: "E56",
      submissionIds: ["Q1"],
      senderAddress: "support@mail.imocto.cn",
    }));
    const runtime = {
      config: catalog.getById("support"),
      client: { send, sendPreparedDraft },
      mailboxAddress: "support@example.test",
      mailAccountId: "42",
      inboxMailboxId: "inbox",
    };
    const runtimes = {
      getById: vi.fn(() => runtime),
    } as unknown as PluginAccountRuntimeRegistry;
    const activateStoredRuntime = vi.fn(
      async () => runtime as unknown as PluginAccountRuntime,
    );
    let pending: Awaited<ReturnType<MailWorkflowStateStore["getPending"]>>;
    const workflowState = {
      savePending: vi.fn(async (value) => {
        pending = value;
      }),
      getPending: vi.fn(async () => pending),
      clearPending: vi.fn(async () => {
        const value = pending;
        pending = undefined;
        return value;
      }),
      notificationDelivered: vi.fn(async () => false),
      markNotificationDelivered: vi.fn(async () => undefined),
    } satisfies MailWorkflowStateStore;
    const sessionKey = "agent:mail-agent:octo:bot-support:direct:owner";
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes,
      ensureRuntimeStarted: vi.fn(async () => undefined),
      activateStoredRuntime,
      workflowState,
      confirmationAuthorityAvailable: true,
    });
    const tools = factory({
      agentId: "mail-agent",
      sessionKey,
      senderIsOwner: true,
    } as OpenClawPluginToolContext) as AnyAgentTool[];

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["mail_confirm_send", "mail_cancel_send"]),
    );
    const prepared = await tools.find((tool) => tool.name === "mail_send")!.execute(
      "send-55",
      { to: ["recipient@example.test"], subject: "Hello", body: "World" },
      undefined,
    );
    expect(prepared.content[0]).toMatchObject({
      text: expect.stringContaining("邮件尚未发送"),
    });
    expect(workflowState.savePending).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey,
        mailAccountId: "42",
        draftId: "E55",
        draftVersion: 1,
      }),
    );
    const confirmed = await tools.find((tool) => tool.name === "mail_confirm_send")!.execute(
      "confirm-55",
      {},
      undefined,
    );
    expect(sendPreparedDraft).toHaveBeenCalledWith("E55", 1, undefined);
    expect(activateStoredRuntime).not.toHaveBeenCalled();
    expect(workflowState.clearPending).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, draftId: "E55", draftVersion: 1 }),
    );
    expect(confirmed.content[0]).toMatchObject({
      text: expect.stringContaining(
        "发件邮箱：support@mail.imocto.cn",
      ),
    });
    expect(confirmed.details).toMatchObject({
      senderAddress: "support@mail.imocto.cn",
      realEmailSent: true,
    });
  });

  it("withholds confirmation tools when no hook authority is registered", () => {
    const catalog = accountCatalog("MyBot");
    const runtime = {
      config: catalog.getById("support"),
      client: {},
      mailboxAddress: "support@example.test",
      mailAccountId: "42",
      inboxMailboxId: "inbox",
    };
    const workflowState = {
      savePending: vi.fn(async () => undefined),
      getPending: vi.fn(async () => undefined),
      clearPending: vi.fn(async () => undefined),
      notificationDelivered: vi.fn(async () => false),
      markNotificationDelivered: vi.fn(async () => undefined),
    } satisfies MailWorkflowStateStore;
    const factory = createAccountMailToolFactory({
      catalog,
      runtimes: {
        getById: vi.fn(() => runtime),
      } as unknown as PluginAccountRuntimeRegistry,
      ensureRuntimeStarted: vi.fn(async () => undefined),
      activateStoredRuntime: vi.fn(
        async () => runtime as unknown as PluginAccountRuntime,
      ),
      workflowState,
      confirmationAuthorityAvailable: false,
    });

    const tools = factory({
      agentId: "mail-agent",
      sessionKey: "agent:mail-agent:octo:bot-support:direct:owner",
      senderIsOwner: true,
    } as OpenClawPluginToolContext) as AnyAgentTool[];

    expect(tools.map((tool) => tool.name)).not.toContain("mail_confirm_send");
    expect(tools.map((tool) => tool.name)).not.toContain("mail_cancel_send");
  });

  it("rejects a pending Draft from a different Plugin Account", async () => {
    const harness = createConfirmationHarness({
      pendingPluginAccountId: "other",
    });

    await expect(harness.confirm()).rejects.toThrow(
      "Pending mail Draft belongs to a different Plugin Account.",
    );
    expect(harness.runtimes.getById).not.toHaveBeenCalled();
    expect(harness.sendPreparedDraft).not.toHaveBeenCalled();
    expect(harness.workflowState.clearPending).not.toHaveBeenCalled();
  });

  it("rejects a pending Draft from a replaced Mail Account", async () => {
    const harness = createConfirmationHarness({
      pendingMailAccountId: "41",
    });

    await expect(harness.confirm()).rejects.toThrow(
      "Pending mail Draft belongs to a different Mail Account.",
    );
    expect(harness.runtimes.getById).toHaveBeenCalledWith("support");
    expect(harness.sendPreparedDraft).not.toHaveBeenCalled();
    expect(harness.workflowState.clearPending).not.toHaveBeenCalled();
  });

  it("preserves pending state when scoped Draft delivery fails", async () => {
    const sendPreparedDraft = vi.fn(async () => {
      throw new Error("delivery outcome unknown");
    });
    const harness = createConfirmationHarness({ sendPreparedDraft });

    await expect(harness.confirm()).rejects.toThrow("delivery outcome unknown");
    expect(harness.workflowState.clearPending).not.toHaveBeenCalled();
    await expect(
      harness.workflowState.getPending(harness.sessionKey),
    ).resolves.toMatchObject({ draftId: "E55", mailAccountId: "42" });
  });

  it("rejects legacy pending state without a Mail Account binding", async () => {
    const harness = createConfirmationHarness({
      pendingMailAccountId: undefined,
    });

    await expect(harness.confirm()).rejects.toThrow(
      "Pending mail Draft is missing its Mail Account binding.",
    );
    expect(harness.runtimes.getById).not.toHaveBeenCalled();
    expect(harness.sendPreparedDraft).not.toHaveBeenCalled();
    expect(harness.workflowState.clearPending).not.toHaveBeenCalled();
  });
});

function accountCatalog(botId = "bot-support"): PluginAccountCatalog {
  return new PluginAccountCatalog(
    parseReliablePluginConfig({
      accounts: [
        {
          pluginAccountId: "support",
          agentId: "mail-agent",
          botId,
          apiBaseUrl: TEST_OCTO_ORIGIN,
          credentialRef: {
            source: "file",
            provider: "support_mail",
            id: "value",
          },
        },
      ],
    }).accounts,
  );
}

function createConfirmationHarness(options: {
  pendingPluginAccountId?: string;
  pendingMailAccountId?: string | undefined;
  sendPreparedDraft?: ReturnType<typeof vi.fn>;
} = {}) {
  const catalog = accountCatalog();
  const sessionKey = "agent:mail-agent:octo:bot-support:direct:owner";
  const sendPreparedDraft =
    options.sendPreparedDraft ??
    vi.fn(async () => ({
      outcome: "accepted" as const,
      messageId: "E56",
      submissionIds: ["Q1"],
    }));
  const runtime = {
    config: catalog.getById("support"),
    client: { sendPreparedDraft },
    mailboxAddress: "support@example.test",
    mailAccountId: "42",
    inboxMailboxId: "inbox",
  };
  const runtimes = {
    getById: vi.fn(() => runtime),
  } as unknown as PluginAccountRuntimeRegistry;
  const hasPendingMailAccountId = Object.prototype.hasOwnProperty.call(
    options,
    "pendingMailAccountId",
  );
  let pending: PendingMailConfirmation | undefined = {
    sessionKey,
    agentId: "mail-agent",
    pluginAccountId: options.pendingPluginAccountId ?? "support",
    ...(hasPendingMailAccountId
      ? options.pendingMailAccountId === undefined
        ? {}
        : { mailAccountId: options.pendingMailAccountId }
      : { mailAccountId: "42" }),
    draftId: "E55",
    draftVersion: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
  };
  const workflowState = {
    savePending: vi.fn(async (value: PendingMailConfirmation) => {
      pending = value;
    }),
    getPending: vi.fn(async (_sessionKey: string) => pending),
    clearPending: vi.fn(async (expected: PendingMailConfirmation) => {
      if (
        pending?.sessionKey !== expected.sessionKey ||
        pending.draftId !== expected.draftId ||
        pending.draftVersion !== expected.draftVersion
      ) {
        return undefined;
      }
      const value = pending;
      pending = undefined;
      return value;
    }),
    notificationDelivered: vi.fn(async () => false),
    markNotificationDelivered: vi.fn(async () => undefined),
  } satisfies MailWorkflowStateStore;
  const factory = createAccountMailToolFactory({
    catalog,
    runtimes,
    ensureRuntimeStarted: vi.fn(async () => undefined),
    activateStoredRuntime: vi.fn(
      async () => runtime as unknown as PluginAccountRuntime,
    ),
    workflowState,
    confirmationAuthorityAvailable: true,
  });
  const tools = factory({
    agentId: "mail-agent",
    sessionKey,
    senderIsOwner: true,
  } as OpenClawPluginToolContext) as AnyAgentTool[];
  const confirmTool = tools.find((tool) => tool.name === "mail_confirm_send")!;

  return {
    sessionKey,
    runtimes,
    sendPreparedDraft,
    workflowState,
    confirm: () => confirmTool.execute("confirm-55", {}, undefined),
  };
}
