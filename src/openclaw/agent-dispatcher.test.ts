import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import {
  buildInboundPrompt,
  buildInboundSessionId,
  createOpenClawInboundMailDispatcher,
} from "./agent-dispatcher.js";

describe("OpenClaw agent dispatch adapter", () => {
  it("targets the configured Agent through the public embedded-agent runtime", async () => {
    const runEmbeddedAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      meta: { stopReason: "completed", durationMs: 1 },
    }));
    const api = {
      config: {},
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: vi.fn(() => "/tmp/poc-agent"),
          resolveAgentTimeoutMs: vi.fn(() => 10_000),
          runEmbeddedAgent,
        },
      },
    } as unknown as OpenClawPluginApi;
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const dispatcher = createOpenClawInboundMailDispatcher(
      api,
      "support-agent",
      logger,
    );

    await dispatcher.dispatch(
      { emailId: "email-1", receivedAt: "2026-08-03T08:00:00.000Z" },
      new AbortController().signal,
    );

    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    expect(runEmbeddedAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support-agent",
        sessionKey: expect.stringMatching(/^agent:support-agent:octo-mail-inbound-/),
        workspaceDir: "/tmp/poc-agent",
        toolsAllow: ["mail_get_message", "mail_reply"],
        disableMessageTool: true,
        requireExplicitMessageTarget: true,
      }),
    );
    expect(runEmbeddedAgent.mock.calls[0]?.[0]?.["prompt"]).toContain(
      "untrusted external content",
    );
  });

  it("derives a safe, bounded session id from an opaque external email id", () => {
    const sessionId = buildInboundSessionId("unsafe:id/../../with spaces");

    expect(sessionId).toMatch(/^[a-z0-9][a-z0-9._-]{0,127}$/i);
    expect(sessionId).not.toContain("unsafe:id");
  });

  it("adds a host-controlled closing instruction only for the final allowed reply", () => {
    const ordinary = buildInboundPrompt({
      emailId: "E1",
      receivedAt: "2026-08-06T00:00:00Z",
      autoReplyCount: 2,
      maxAutoReplyCount: 4,
      nextReplyIsFinal: false,
    });
    const final = buildInboundPrompt({
      emailId: "E2",
      receivedAt: "2026-08-06T00:00:00Z",
      autoReplyCount: 3,
      maxAutoReplyCount: 4,
      nextReplyIsFinal: true,
    });

    expect(ordinary).not.toContain("last automatic reply");
    expect(final).toContain("last automatic reply");
    expect(final).toContain("do not ask a new non-essential question");
  });

  it("uses reply Drafts in manual mode and scoped auto reply only when enabled", async () => {
    const runEmbeddedAgent = vi.fn(async (_params: Record<string, unknown>) => ({
      meta: { stopReason: "completed", durationMs: 1 },
    }));
    const api = {
      config: {},
      runtime: {
        agent: {
          resolveAgentWorkspaceDir: vi.fn(() => "/tmp/inbound-agent"),
          resolveAgentTimeoutMs: vi.fn(() => 10_000),
          runEmbeddedAgent,
        },
      },
    } as unknown as OpenClawPluginApi;
    const dispatcher = createOpenClawInboundMailDispatcher(
      api,
      "support-agent",
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    );

    await dispatcher.dispatch(
      {
        emailId: "E-manual",
        receivedAt: "2026-08-08T00:00:00Z",
        automaticSendEnabled: false,
      },
      new AbortController().signal,
    );
    await dispatcher.dispatch(
      {
        emailId: "E-auto",
        receivedAt: "2026-08-08T00:00:01Z",
        automaticSendEnabled: true,
      },
      new AbortController().signal,
    );

    expect(runEmbeddedAgent.mock.calls[0]?.[0]).toMatchObject({
      toolsAllow: ["mail_get_message", "mail_reply"],
    });
    expect(runEmbeddedAgent.mock.calls[0]?.[0]?.["prompt"]).toContain(
      "manual-confirmation mode",
    );
    expect(runEmbeddedAgent.mock.calls[1]?.[0]).toMatchObject({
      toolsAllow: ["mail_get_message", "mail_auto_reply"],
    });
  });
});
