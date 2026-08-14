import { describe, expect, it } from "vitest";

import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import { buildMailToolGuidance } from "./mail-tool-guidance.js";

describe("buildMailToolGuidance", () => {
  it("does not inject mail guidance into unrelated providers", () => {
    expect(
      buildMailToolGuidance({
        messageProvider: "discord",
        agentId: "support-agent",
        accounts: [account()],
      }),
    ).toBeNull();
  });

  it("teaches a configured OCTO Agent the dedicated mail flow", () => {
    const guidance = buildMailToolGuidance({
      messageProvider: "octo",
      agentId: "support-agent",
      accounts: [account()],
    });
    expect(guidance).toContain("mail_connect");
    expect(guidance).toContain("mail_connection_status");
    expect(guidance).toContain("never pass it an address");
    expect(guidance).toContain("current outbound mode");
    expect(guidance).toContain("owner_confirmation_required");
    expect(guidance).toContain("owner_review_required");
    expect(guidance).toContain("senderAddress");
    expect(guidance).toContain("never infer or copy a sender address");
    expect(guidance).toContain("邮件 → 草稿箱");
    expect(guidance).not.toContain("确认发送");
    expect(guidance).not.toContain("mail_confirm_send");
    expect(guidance).not.toContain("mail_cancel_send");
    expect(guidance).toContain("unsent reply Draft");
    expect(guidance).toContain("replaceExisting=true");
    expect(guidance).toContain("mail_connect.spaceId");
    expect(guidance).toContain("Do not call mail_connection_status before mail_send");
    expect(guidance).toContain("do not search for another mail provider");
    expect(guidance).toContain("or claim success");
  });

  it("fails closed for an unconfigured or ambiguous OCTO Agent", () => {
    expect(
      buildMailToolGuidance({
        messageProvider: "octo",
        agentId: "other-agent",
        accounts: [account()],
      }),
    ).toContain("not configured");
    expect(
      buildMailToolGuidance({
        messageProvider: "octo",
        agentId: "support-agent",
        accounts: [account(), account("support-2")],
      }),
    ).toContain("ambiguous");
  });
});

function account(pluginAccountId = "support"): PluginAccountConfig {
  return {
    pluginAccountId,
    enabled: true,
    agentId: "support-agent",
    botId: `bot-${pluginAccountId}`,
    apiBaseUrl: "https://octo.example.test",
    credentialRef: {
      source: "file",
      provider: `${pluginAccountId}_mail`,
      id: "value",
    },
    discovery: { enabled: true, pollIntervalMs: 5_000, maxChanges: 100 },
  };
}
