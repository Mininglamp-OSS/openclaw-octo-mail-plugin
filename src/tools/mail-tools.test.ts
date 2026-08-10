import { describe, expect, it, vi } from "vitest";

import {
  createMailGetMessageTool,
  createMailAutoReplyTool,
  createMailReplyTool,
  createMailSendTool,
} from "./mail-tools.js";
import { createSyntheticMailClient } from "../testing/synthetic-mail-client.js";

interface ExecutableTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

describe("POC mail tools", () => {
  const options = { client: createSyntheticMailClient(), simulated: true };

  it("marks all email content as untrusted external input", async () => {
    const tool = createMailGetMessageTool(options) as ExecutableTool;
    const result = await tool.execute("call-1", { emailId: "email-1" });

    expect(result.content[0]?.text).toContain("UNTRUSTED EMAIL CONTENT");
    expect(result.content[0]?.text).toContain("emailId: email-1");
    expect(result.details).toMatchObject({
      trust: "untrusted-external-content",
    });
  });

  it("does not claim that the POC reply sends a real email", async () => {
    const tool = createMailReplyTool(options) as ExecutableTool;
    const result = await tool.execute("call-2", {
      emailId: "email-1",
      body: "Acknowledged.",
    });

    expect(result.content[0]?.text).toContain("No real email was sent");
    expect(result.details).toMatchObject({ realEmailSent: false });
  });

  it("passes exact new-message fields through the send tool", async () => {
    const tool = createMailSendTool(options) as ExecutableTool;
    const result = await tool.execute("call-send", {
      to: ["recipient@example.test"],
      subject: "Hello",
      body: "Exact body",
    });

    expect(result.content[0]?.text).toContain("No real email was sent");
    expect(result.details).toMatchObject({ realEmailSent: false });
  });

  it("reports a chain-limit stop as not sent without requesting approval", async () => {
    const client = createSyntheticMailClient();
    client.replyAutomatically = async () => ({
      outcome: "auto_reply_stopped",
      reason: "max_auto_replies_reached",
    });
    const tool = createMailAutoReplyTool({
      client,
      simulated: false,
    }) as ExecutableTool;

    const result = await tool.execute("call-auto-stop", {
      emailId: "E7",
      body: "One more reply",
    });

    expect(result.content[0]?.text).toContain("No email was sent");
    expect(result.details).toMatchObject({
      outcome: "auto_reply_stopped",
      reason: "max_auto_replies_reached",
      realEmailSent: false,
    });
  });

  it("notifies the owner when a background automatic reply is held by a rule", async () => {
    const client = createSyntheticMailClient();
    client.replyAutomatically = async () => ({
      outcome: "owner_review_required",
      status: "pending_confirmation",
      draftId: "E42",
      draftSubject: "Re: Payment",
      draftVersion: 1,
      policyVersion: "policy-v1",
      reasons: [
        {
          code: "payment",
          title: "需要人工确认",
          description: "涉及付款信息",
        },
      ],
      source: "inbound_auto_reply",
      sourceEmailId: "E7",
    });
    const onOwnerReviewDraft = vi.fn(async () => undefined);
    const tool = createMailAutoReplyTool({
      client,
      simulated: false,
      onOwnerReviewDraft,
    }) as ExecutableTool;

    const result = await tool.execute("call-auto-policy", {
      emailId: "E7",
      body: "Please review",
    });

    expect(onOwnerReviewDraft).toHaveBeenCalledWith(
      expect.objectContaining({ draftId: "E42" }),
      { emailId: "E7", body: "Please review" },
    );
    expect(result.details).toMatchObject({
      outcome: "owner_review_required",
      realEmailSent: false,
    });
  });
});
