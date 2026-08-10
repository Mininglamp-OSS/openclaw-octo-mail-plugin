import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import {
  MAIL_AUTO_REPLY_TOOL_NAME,
  MAIL_CANCEL_SEND_TOOL_NAME,
  MAIL_CONFIRM_SEND_TOOL_NAME,
  MAIL_REPLY_TOOL_NAME,
  MAIL_SEND_TOOL_NAME,
} from "../constants.js";

const GRANT_TTL_MS = 2 * 60_000;

export type MailTextConfirmationAction = "confirm" | "cancel";

type TurnGrant = {
  runId: string;
  action: MailTextConfirmationAction;
  agentId?: string;
  sessionKey: string;
  expiresAtMs: number;
};

/**
 * Authorizes one internal confirmation Tool call from an exact trusted-owner
 * text turn. This Hook is the single approval authority. The durable workflow
 * store independently owns which versioned Draft is pending for the session.
 */
export class MailTextConfirmationGate {
  readonly #turnGrants = new Map<string, TurnGrant>();
  readonly #protectedRuns = new Map<string, TurnGrant>();

  observeOwnerTurn(input: {
    prompt: string;
    senderIsOwner: boolean | undefined;
    runId: string | undefined;
    agentId: string | undefined;
    sessionKey: string | undefined;
    channelId?: string | undefined;
  }): void {
    this.#prune();
    const action = exactConfirmationAction(input.prompt);
    if (
      action === undefined ||
      input.senderIsOwner !== true ||
      input.runId === undefined ||
      input.sessionKey === undefined ||
      !input.sessionKey.includes(":direct:")
    ) {
      return;
    }
    const grant: TurnGrant = {
      runId: input.runId,
      action,
      ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
      sessionKey: input.sessionKey,
      expiresAtMs: Date.now() + GRANT_TTL_MS,
    };
    this.#turnGrants.set(input.runId, grant);
    // Keep a separate run marker after the one-shot Tool grant is consumed.
    // This prevents a model from falling back to mail_send and creating a new
    // Draft when confirmation execution fails for any reason.
    this.#protectedRuns.set(input.runId, grant);
  }

  blocksDraftPreparation(input: {
    toolName: string;
    runId: string | undefined;
    agentId: string | undefined;
    sessionKey: string | undefined;
  }): boolean {
    this.#prune();
    if (input.runId === undefined || !isDraftPreparationTool(input.toolName)) {
      return false;
    }
    const grant = this.#protectedRuns.get(input.runId);
    return (
      grant !== undefined &&
      grant.sessionKey === input.sessionKey &&
      (grant.agentId === undefined || grant.agentId === input.agentId)
    );
  }

  instructionForRun(runId: string | undefined): string | undefined {
    this.#prune();
    if (runId === undefined) return undefined;
    const grant = this.#turnGrants.get(runId);
    if (grant === undefined) return undefined;
    return grant.action === "confirm"
      ? `The trusted owner entered the exact OCTO Mail confirmation command. Call ${MAIL_CONFIRM_SEND_TOOL_NAME} exactly once with no arguments. Do not call mail_send or alter the saved Draft.`
      : `The trusted owner entered the exact OCTO Mail cancellation command. Call ${MAIL_CANCEL_SEND_TOOL_NAME} exactly once with no arguments. Do not send mail.`;
  }

  authorizeToolCall(input: {
    toolName: string;
    runId: string | undefined;
    agentId: string | undefined;
    sessionKey: string | undefined;
  }): boolean {
    this.#prune();
    const action = toolAction(input.toolName);
    if (
      action === undefined ||
      input.runId === undefined ||
      input.sessionKey === undefined
    ) {
      return false;
    }
    const grant = this.#turnGrants.get(input.runId);
    if (
      grant === undefined ||
      grant.action !== action ||
      grant.sessionKey !== input.sessionKey ||
      (grant.agentId !== undefined && grant.agentId !== input.agentId)
    ) {
      return false;
    }
    this.#turnGrants.delete(input.runId);
    return true;
  }

  #prune(): void {
    const now = Date.now();
    for (const [runId, grant] of this.#turnGrants) {
      if (grant.expiresAtMs <= now) this.#turnGrants.delete(runId);
    }
    for (const [runId, grant] of this.#protectedRuns) {
      if (grant.expiresAtMs <= now) this.#protectedRuns.delete(runId);
    }
  }
}

export function registerMailWriteApproval(
  api: OpenClawPluginApi,
): MailTextConfirmationGate {
  const gate = new MailTextConfirmationGate();

  api.on(
    "before_agent_run",
    (event, ctx) => {
      gate.observeOwnerTurn({
        prompt: event.prompt,
        senderIsOwner: event.senderIsOwner,
        runId: ctx.runId,
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        channelId: event.channelId,
      });
    },
    { priority: 100, timeoutMs: 5_000 },
  );

  api.on(
    "before_prompt_build",
    (_event, ctx) => {
      const instruction = gate.instructionForRun(ctx.runId);
      return instruction === undefined
        ? undefined
        : { appendContext: instruction };
    },
    { priority: 100, timeoutMs: 5_000 },
  );

  api.on(
    "before_tool_call",
    (event, ctx) => {
      if (
        gate.blocksDraftPreparation({
          toolName: event.toolName,
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        })
      ) {
        return {
          block: true,
          blockReason:
            "This is an exact mail confirmation/cancellation turn. Recreating or changing the Draft is forbidden; use only the matching internal confirmation action.",
        };
      }
      const action = toolAction(event.toolName);
      if (action === undefined) return;
      if (
        gate.authorizeToolCall({
          toolName: event.toolName,
          runId: ctx.runId,
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
        })
      ) {
        return;
      }
      return {
        block: true,
        blockReason:
          "No matching exact trusted-owner mail confirmation exists for this session and run.",
      };
    },
    { priority: 100, timeoutMs: 5_000 },
  );

  return gate;
}

function exactConfirmationAction(
  prompt: string,
): MailTextConfirmationAction | undefined {
  const normalized = prompt.trim();
  if (normalized === "确认发送") return "confirm";
  if (normalized === "取消发送") return "cancel";
  // OCTO's standard OpenClaw inbound adapter wraps one user message in a
  // trusted, single-line channel envelope before before_agent_run. Accept only
  // that exact envelope and exact command; do not use suffix/substring matching.
  const match = /^\[Octo user:[^\]\r\n]+\]\s*(确认发送|取消发送)$/.exec(
    normalized,
  );
  if (match?.[1] === "确认发送") return "confirm";
  if (match?.[1] === "取消发送") return "cancel";
  return undefined;
}

function isDraftPreparationTool(toolName: string): boolean {
  return (
    toolName === MAIL_SEND_TOOL_NAME ||
    toolName === MAIL_REPLY_TOOL_NAME ||
    toolName === MAIL_AUTO_REPLY_TOOL_NAME
  );
}

function toolAction(toolName: string): MailTextConfirmationAction | undefined {
  if (toolName === MAIL_CONFIRM_SEND_TOOL_NAME) return "confirm";
  if (toolName === MAIL_CANCEL_SEND_TOOL_NAME) return "cancel";
  return undefined;
}
