import type {
  AnyAgentTool,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { Type, type Static } from "typebox";

import type { PluginAccountCatalog } from "../accounts/plugin-account.js";
import type { AgentMailAuthorizationService } from "../auth/agent-mail-authorization-service.js";
import {
  MAIL_CONNECTION_STATUS_TOOL_NAME,
  MAIL_CONNECT_TOOL_NAME,
} from "../constants.js";

const connectParameters = Type.Object(
  {
    mailboxAddress: Type.String({ minLength: 3, maxLength: 320 }),
    spaceId: Type.String({
      minLength: 1,
      maxLength: 200,
      description:
        "Use the exact OCTO Space identifier supplied by the mailbox setup prompt. It scopes the owner's approval and does not grant access by itself.",
    }),
    replaceExisting: Type.Optional(
      Type.Boolean({
        description:
          "Set true only when the user explicitly asks to re-authorize, replace the current mailbox, or change mailbox permissions.",
      }),
    ),
  },
  { additionalProperties: false },
);
const statusParameters = Type.Object({}, { additionalProperties: false });

type ConnectParameters = Static<typeof connectParameters>;

export interface MailAuthorizationToolFactoryOptions {
  catalog: PluginAccountCatalog;
  getService: () =>
    | AgentMailAuthorizationService
    | Promise<AgentMailAuthorizationService>;
  getConnectedMailboxAddress: (
    pluginAccountId: string,
  ) => string | undefined | Promise<string | undefined>;
}

/**
 * Tools are offered only when trusted host agentId identifies one account.
 * The model cannot provide or override pluginAccountId, botId, or botProfile.
 */
export function createMailAuthorizationToolFactory(
  options: MailAuthorizationToolFactoryOptions,
): OpenClawPluginToolFactory {
  return (context) => {
    const account = resolveUnambiguousAccount(options.catalog, context);
    if (account === undefined) {
      return null;
    }
    return [
      createMailConnectTool(options, account.pluginAccountId),
      createMailConnectionStatusTool(options, account.pluginAccountId),
    ];
  };
}

function createMailConnectTool(
  options: MailAuthorizationToolFactoryOptions,
  pluginAccountId: string,
): AnyAgentTool {
  return {
    name: MAIL_CONNECT_TOOL_NAME,
    label: "Connect Agent Mail",
    description:
      "Connect the current Agent's own sender mailbox through human approval. If the same mailbox is already connected, return that status without creating another request. Set replaceExisting=true only when the user explicitly asks to re-authorize, replace the mailbox, or change permissions such as automatic sending. Never use a recipient address from a request such as 'send email to X'; use mail_send.to for recipients. The trusted Bot identity comes from plugin configuration, never tool arguments.",
    parameters: connectParameters,
    executionMode: "sequential",
    async execute(_toolCallId, rawParams, signal) {
      const params = rawParams as ConnectParameters;
      const account = options.catalog.getById(pluginAccountId);
      const service = await options.getService();
      const connectedMailboxAddress =
        await options.getConnectedMailboxAddress(pluginAccountId);
      if (
        params.replaceExisting !== true &&
        connectedMailboxAddress !== undefined &&
        connectedMailboxAddress.trim().toLowerCase() ===
          params.mailboxAddress.trim().toLowerCase()
      ) {
        const details = {
          status: "connected" as const,
          pluginAccountId,
          mailboxAddress: connectedMailboxAddress,
          alreadyConnected: true,
        };
        return {
          content: [
            {
              type: "text",
              text: `Agent Mail is already connected: ${connectedMailboxAddress}. No new authorization is required.`,
            },
          ],
          details,
        };
      }
      const result = await service.start(
        account,
        params.mailboxAddress,
        params.spaceId,
        signal,
      );
      return {
        content: [
          {
            type: "text",
            text: [
              "Agent Mail authorization requires the mailbox owner's approval.",
              `Open: ${result.verificationUri}`,
              `Code: ${result.userCode}`,
              `Expires at: ${result.expiresAt}`,
              "The plugin will complete the connection automatically after approval.",
              `Use ${MAIL_CONNECTION_STATUS_TOOL_NAME} only to verify the result on request.`,
            ].join("\n"),
          },
        ],
        details: result,
      };
    },
  };
}

function createMailConnectionStatusTool(
  options: MailAuthorizationToolFactoryOptions,
  pluginAccountId: string,
): AnyAgentTool {
  return {
    name: MAIL_CONNECTION_STATUS_TOOL_NAME,
    label: "Check Agent Mail connection",
    description:
      "Inspect a requested mailbox connection or report the already connected sender mailbox. This is not a prerequisite for mail_send when that Tool is available, and no pending authorization does not mean an existing connection expired.",
    parameters: statusParameters,
    executionMode: "sequential",
    async execute(_toolCallId, _rawParams, signal) {
      const account = options.catalog.getById(pluginAccountId);
      const service = await options.getService();
      let result = await service.check(account, signal);
      if (
        result.status !== "pending" &&
        result.status !== "connected"
      ) {
        const mailboxAddress = await options.getConnectedMailboxAddress(
          pluginAccountId,
        );
        if (mailboxAddress !== undefined) {
          result = {
            status: "connected",
            pluginAccountId,
            mailboxAddress,
          };
        }
      }
      return {
        content: [{ type: "text", text: formatStatus(result) }],
        details: result,
      };
    },
  };
}

function resolveUnambiguousAccount(
  catalog: PluginAccountCatalog,
  context: OpenClawPluginToolContext,
) {
  const agentId = context.agentId?.trim();
  if (agentId === undefined || agentId.length === 0) {
    return undefined;
  }
  const accounts = catalog.listByAgentId(agentId);
  return accounts.length === 1 ? accounts[0] : undefined;
}

function formatStatus(
  result: Awaited<ReturnType<AgentMailAuthorizationService["check"]>>,
): string {
  switch (result.status) {
    case "pending":
      return `Agent Mail authorization is still pending. Open ${result.verificationUri}`;
    case "connected":
      return `Agent Mail connected successfully: ${result.mailboxAddress}`;
    case "expired":
      return `Agent Mail authorization expired. Call ${MAIL_CONNECT_TOOL_NAME} again.`;
    case "denied":
      return "Agent Mail authorization was denied by the mailbox owner.";
    case "used":
      return `Agent Mail authorization was already used. Check the connection or call ${MAIL_CONNECT_TOOL_NAME} again.`;
    case "not_started":
      return `No pending Agent Mail authorization. Call ${MAIL_CONNECT_TOOL_NAME} first.`;
  }
}
