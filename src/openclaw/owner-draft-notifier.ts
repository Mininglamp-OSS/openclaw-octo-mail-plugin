import { createHash } from "node:crypto";

import type {
  OpenClawPluginApi,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";

import type {
  MailMessage,
  MailOwnerConfirmationRequired,
  MailOwnerReviewRequired,
} from "../mail/mail-client.js";
import type { MailWorkflowStateStore } from "../runtime/mail-workflow-state-store.js";

export interface OwnerReplyDraftNotification {
  agentId: string;
  pluginAccountId: string;
  botId: string;
  mailboxAddress: string;
  draft: MailOwnerConfirmationRequired | MailOwnerReviewRequired;
  sourceMessage: MailMessage;
}

export class OpenClawOwnerDraftNotifier {
  readonly #api: OpenClawPluginApi;
  readonly #state: MailWorkflowStateStore;
  readonly #logger: PluginLogger;

  constructor(options: {
    api: OpenClawPluginApi;
    state: MailWorkflowStateStore;
    logger: PluginLogger;
  }) {
    this.#api = options.api;
    this.#state = options.state;
    this.#logger = options.logger;
  }

  async notifyReplyDraft(input: OwnerReplyDraftNotification): Promise<void> {
    const notificationId = stableNotificationId(input);
    if (await this.#state.notificationDelivered(notificationId)) return;

    const session = resolveLatestOwnerSession(
      this.#api,
      input.agentId,
      input.botId,
    );
    if (session === undefined) {
      throw new Error(
        `no direct owner session is available for Agent ${input.agentId}`,
      );
    }
    const text = buildNotificationText(input);
    const delivery = session.deliveryContext;
    if (delivery === undefined) {
      throw new Error("owner direct session has no outbound delivery context");
    }
    const channel = delivery.channel?.trim();
    const to = delivery.to?.trim();
    if (channel !== "octo" || to === undefined || to.length === 0) {
      throw new Error("owner direct session has no valid OCTO outbound route");
    }
    const outbound = await this.#api.runtime.channel.outbound.loadAdapter(channel);
    if (outbound?.sendText === undefined) {
      throw new Error("OCTO outbound text adapter is unavailable");
    }
    await outbound.sendText({
      cfg: this.#api.config,
      to,
      text,
      accountId: input.botId,
      ...(delivery.threadId === undefined
        ? {}
        : { threadId: delivery.threadId }),
    });
    await this.#state.markNotificationDelivered(notificationId);
    this.#logger.info(
      `[octo-mail] owner notified about unsent reply Draft ${input.draft.draftId} in session ${session.sessionKey}`,
    );
  }
}

function resolveLatestOwnerSession(
  api: OpenClawPluginApi,
  agentId: string,
  botId: string,
):
  | {
      sessionKey: string;
      deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
        threadId?: string | number;
      };
    }
  | undefined {
  const candidates = api.runtime.agent.session
    .listSessionEntries({ agentId })
    .filter(({ sessionKey, entry }) => {
      if (sessionKey.includes(":octo-mail-inbound-")) return false;
      const direct =
        entry.chatType === "direct" || sessionKey.includes(":direct:");
      const channel =
        entry.deliveryContext?.channel ?? entry.lastChannel ?? entry.channel;
      const to = entry.deliveryContext?.to ?? entry.lastTo;
      const accountId =
        entry.deliveryContext?.accountId ?? entry.lastAccountId;
      return (
        direct &&
        channel === "octo" &&
        accountId === botId &&
        typeof to === "string"
      );
    })
    .sort(
      (left, right) =>
        (right.entry.lastActivityAt ?? right.entry.updatedAt) -
        (left.entry.lastActivityAt ?? left.entry.updatedAt),
    );
  const selected = candidates[0];
  if (selected === undefined) return undefined;
  const fallbackChannel = selected.entry.lastChannel ?? selected.entry.channel;
  const fallbackTo = selected.entry.lastTo;
  const deliveryContext =
    selected.entry.deliveryContext ??
    (fallbackChannel === undefined || fallbackTo === undefined
      ? undefined
      : {
          channel: fallbackChannel,
          to: fallbackTo,
          ...(selected.entry.lastAccountId === undefined
            ? {}
            : { accountId: selected.entry.lastAccountId }),
          ...(selected.entry.lastThreadId === undefined
            ? {}
            : { threadId: selected.entry.lastThreadId }),
        });
  return {
    sessionKey: selected.sessionKey,
    ...(deliveryContext === undefined ? {} : { deliveryContext }),
  };
}

function buildNotificationText(input: OwnerReplyDraftNotification): string {
  const sender = input.sourceMessage.from
    .map((item) => item.email)
    .join(", ");
  const reason =
    input.draft.outcome === "owner_review_required"
      ? input.draft.reasons
          .map((item) => `${item.title}：${item.description}`)
          .join("；")
      : "";
  return [
    input.draft.outcome === "owner_review_required"
      ? "收到一封新邮件，拟回复内容触发了发信规则，邮件未发送并已保存为草稿。"
      : "收到一封新邮件，我已生成回复草稿，尚未发送。",
    "",
    `邮箱：${input.mailboxAddress}`,
    `发件人：${sender || "未知发件人"}`,
    `原邮件主题：${input.sourceMessage.subject || "无主题"}`,
    `草稿主题：${input.draft.draftSubject || "无主题"}`,
    ...(reason === "" ? [] : [`触发规则：${reason}`]),
    "",
    "请前往「邮件 → 草稿箱」查看、编辑并发送。",
  ].join("\n");
}

function stableNotificationId(input: OwnerReplyDraftNotification): string {
  return createHash("sha256")
    .update(
      [
        input.pluginAccountId,
        input.draft.draftId,
        String(input.draft.draftVersion),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
}
