import type { OpenClawPluginToolFactory } from "openclaw/plugin-sdk/plugin-entry";

import type {
  PluginAccountRuntime,
  PluginAccountRuntimeRegistry,
} from "../accounts/account-runtime-registry.js";
import type { PluginAccountCatalog } from "../accounts/plugin-account.js";
import { PluginAccountRoutingError } from "../accounts/plugin-account.js";
import { MailClientError, type MailClient } from "../mail/mail-client.js";
import type { OpenClawOwnerDraftNotifier } from "../openclaw/owner-draft-notifier.js";
import type { MailWorkflowStateStore } from "../runtime/mail-workflow-state-store.js";
import {
  createMailAutoReplyTool,
  createMailCancelSendTool,
  createMailConfirmSendTool,
  createMailGetMessageTool,
  createMailReplyTool,
  createMailSendTool,
} from "./mail-tools.js";

export function createAccountMailToolFactory(options: {
  catalog: PluginAccountCatalog;
  runtimes: PluginAccountRuntimeRegistry;
  ensureRuntimeStarted: () => void | Promise<void>;
  activateStoredRuntime: (
    pluginAccountId: string,
  ) => PluginAccountRuntime | Promise<PluginAccountRuntime>;
  workflowState?: MailWorkflowStateStore;
  ownerDraftNotifier?: OpenClawOwnerDraftNotifier;
}): OpenClawPluginToolFactory {
  return (context) => {
    const agentId = context.agentId?.trim();
    if (agentId === undefined || agentId.length === 0) {
      return null;
    }
    if (options.catalog.listByAgentId(agentId).length !== 1) {
      return null;
    }
    const account = options.catalog.listByAgentId(agentId)[0]!;
    const client = createLazyAccountMailClient({
      pluginAccountId: account.pluginAccountId,
      runtimes: options.runtimes,
      ensureRuntimeStarted: options.ensureRuntimeStarted,
      activateStoredRuntime: options.activateStoredRuntime,
    });
    const ownerDraftNotifier = options.ownerDraftNotifier;
    const inboundOwnerDraftCallbacks =
      isHostInboundMailSession(context.sessionKey, agentId) &&
      ownerDraftNotifier !== undefined
        ? {
            onReplyDraft: notifyOwnerReplyDraft,
            onOwnerReviewDraft: notifyOwnerReplyDraft,
          }
        : {};
    const tools = [
      createMailGetMessageTool({
        client,
        simulated: false,
      }),
      createMailReplyTool({
        client,
        simulated: false,
        ...inboundOwnerDraftCallbacks,
      }),
      createMailSendTool({
        client,
        simulated: false,
        ...(context.senderIsOwner === true &&
        context.sessionKey?.includes(":direct:") === true
          ? { onOwnerConfirmationDraft: async (draft) => {
          if (options.workflowState === undefined) {
            throw new Error("mail workflow state is unavailable");
          }
          if (context.sessionKey === undefined) {
            throw new Error("mail confirmation requires a trusted session key");
          }
          await options.workflowState.savePending({
            sessionKey: context.sessionKey,
            agentId,
            pluginAccountId: account.pluginAccountId,
            draftId: draft.draftId,
            draftVersion: draft.draftVersion,
            createdAt: new Date().toISOString(),
          });
        } }
          : {}),
      }),
    ];
    if (isHostInboundMailSession(context.sessionKey, agentId)) {
      tools.push(
        createMailAutoReplyTool({
          client,
          simulated: false,
          ...inboundOwnerDraftCallbacks,
        }),
      );
    }
    if (
      context.sessionKey !== undefined &&
      context.sessionKey.includes(":direct:") &&
      options.workflowState !== undefined
    ) {
      const confirmationOptions = {
        client,
        workflowState: options.workflowState,
        agentId: agentId!,
        sessionKey: context.sessionKey,
      };
      tools.push(
        createMailConfirmSendTool(confirmationOptions),
        createMailCancelSendTool(confirmationOptions),
      );
    }
    return tools;

    async function getRuntime(): Promise<PluginAccountRuntime> {
      await options.ensureRuntimeStarted();
      try {
        return options.runtimes.getById(account.pluginAccountId);
      } catch (error) {
        if (!(error instanceof PluginAccountRoutingError)) throw error;
        return await options.activateStoredRuntime(account.pluginAccountId);
      }
    }

    async function notifyOwnerReplyDraft(
      draft: Parameters<OpenClawOwnerDraftNotifier["notifyReplyDraft"]>[0]["draft"],
      input: { emailId: string },
    ): Promise<void> {
      if (ownerDraftNotifier === undefined) return;
      const runtime = await getRuntime();
      const sourceMessage = await runtime.client.getMessage(input.emailId);
      await ownerDraftNotifier.notifyReplyDraft({
        agentId: agentId!,
        pluginAccountId: account.pluginAccountId,
        botId: account.botId,
        mailboxAddress: runtime.mailboxAddress,
        draft,
        sourceMessage,
      });
    }
  };
}

function createLazyAccountMailClient(options: {
  pluginAccountId: string;
  runtimes: PluginAccountRuntimeRegistry;
  ensureRuntimeStarted: () => void | Promise<void>;
  activateStoredRuntime: (
    pluginAccountId: string,
  ) => PluginAccountRuntime | Promise<PluginAccountRuntime>;
}): MailClient {
  const getClient = async (): Promise<MailClient> => {
    await options.ensureRuntimeStarted();
    try {
      return options.runtimes.getById(options.pluginAccountId).client;
    } catch (error) {
      if (error instanceof PluginAccountRoutingError) {
        try {
          return (
            await options.activateStoredRuntime(options.pluginAccountId)
          ).client;
        } catch (activationError) {
          if (activationError instanceof PluginAccountRoutingError) {
            throw new MailClientError({
              code: "mailbox_not_connected",
              message:
                "The current Agent has no connected sender mailbox. Use mail_connect only for the Agent's own mailbox; never connect a recipient address.",
              cause: activationError,
            });
          }
          throw activationError;
        }
      }
      throw error;
    }
  };
  return {
    async getMessage(emailId, signal) {
      return await (await getClient()).getMessage(emailId, signal);
    },
    async reply(emailId, text, signal, intentId) {
      return await (await getClient()).reply(emailId, text, signal, intentId);
    },
    async replyAutomatically(emailId, text, signal, intentId) {
      return await (await getClient()).replyAutomatically(
        emailId,
        text,
        signal,
        intentId,
      );
    },
    async send(input, signal, intentId) {
      return await (await getClient()).send(input, signal, intentId);
    },
    async confirmDraft(draftId, draftVersion, signal, intentId) {
      return await (await getClient()).confirmDraft(
        draftId,
        draftVersion,
        signal,
        intentId,
      );
    },
  };
}

function isHostInboundMailSession(
  sessionKey: string | undefined,
  agentId: string,
): boolean {
  return sessionKey?.startsWith(`agent:${agentId}:octo-mail-inbound-`) === true;
}
