import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type { AuthorizationStatusResult } from "../auth/agent-mail-authorization-service.js";
import { parsePluginConfig } from "../config/plugin-config.js";
import { bindStandardMailbox } from "./standard-bind.js";

describe("bindStandardMailbox", () => {
  it("starts owner authorization using the trusted Agent/Bot mapping", async () => {
    const service = createService();
    const onAuthorizationRequired = vi.fn();

    const result = await bindStandardMailbox(
      baseOptions({ onAuthorizationRequired }),
      {
        credentialExists: vi.fn(async () => false),
        createAuthorizationService: () => service,
      },
    );

    expect(service.start).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support-agent",
        botId: "bot-support",
        apiBaseUrl: "https://octo.example.test",
      }),
      "support@example.test",
      "space-support",
    );
    expect(onAuthorizationRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationUri: "https://octo.example.test/authorize?code=ABCD",
      }),
    );
    expect(result).toEqual({
      status: "authorization_required",
      pluginAccountId: expect.stringMatching(/^mail_bot-support_/),
      mailboxAddress: "support@example.test",
      verificationUri: "https://octo.example.test/authorize?code=ABCD",
      expiresAt: "2026-08-06T10:10:00.000Z",
    });
    expect(service.stop).toHaveBeenCalledOnce();
  });

  it("treats api-url as an assertion and never as an override", async () => {
    const service = createService();
    await expect(
      bindStandardMailbox(
        baseOptions({ apiUrl: "https://attacker.example.test" }),
        {
          credentialExists: vi.fn(async () => false),
          createAuthorizationService: () => service,
        },
      ),
    ).rejects.toThrow(/does not match the trusted OCTO binding/);
    expect(service.start).not.toHaveBeenCalled();
  });

  it("fails closed when the Agent has no unambiguous trusted binding", async () => {
    const config = createConfig();
    config.bindings!.push({
      agentId: "support-agent",
      match: { channel: "octo", accountId: "bot-second" },
    });

    await expect(
      bindStandardMailbox(
        baseOptions({ config }),
        { credentialExists: vi.fn(async () => false) },
      ),
    ).rejects.toThrow(/no usable OCTO Bot binding|ambiguous/);
  });

  it("is idempotent for the same verified connected mailbox", async () => {
    const service = createService();
    const result = await bindStandardMailbox(baseOptions(), {
      credentialExists: vi.fn(async () => true),
      readCredential: vi.fn(() => "omb_private_value"),
      getIdentityAddress: vi.fn(async () => "Support@Example.Test"),
      createAuthorizationService: () => service,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "connected",
        mailboxAddress: "Support@Example.Test",
        alreadyConnected: true,
      }),
    );
    expect(service.start).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("omb_private_value");
  });

  it("refuses to silently replace a different connected mailbox", async () => {
    await expect(
      bindStandardMailbox(baseOptions(), {
        credentialExists: vi.fn(async () => true),
        readCredential: vi.fn(() => "omb_private_value"),
        getIdentityAddress: vi.fn(async () => "other@example.test"),
      }),
    ).rejects.toThrow(/refusing to replace/);
  });

  it("can wait until the authorization reaches connected", async () => {
    const service = createService([
      {
        status: "pending",
        pluginAccountId: "mail-test",
        userCode: "ABCD",
        verificationUri: "https://octo.example.test/authorize?code=ABCD",
        expiresAt: "2026-08-06T10:10:00.000Z",
        pollIntervalSeconds: 1,
      },
      {
        status: "connected",
        pluginAccountId: "mail-test",
        mailboxAddress: "support@example.test",
      },
    ]);
    const sleep = vi.fn(async () => undefined);

    const result = await bindStandardMailbox(baseOptions({ wait: true }), {
      credentialExists: vi.fn(async () => false),
      createAuthorizationService: () => service,
      sleep,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "connected",
        mailboxAddress: "support@example.test",
        alreadyConnected: false,
      }),
    );
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(service.stop).toHaveBeenCalledOnce();
  });
});

function baseOptions(
  overrides: Partial<Parameters<typeof bindStandardMailbox>[0]> = {},
): Parameters<typeof bindStandardMailbox>[0] {
  const config = overrides.config ?? createConfig();
  return {
    config,
    pluginConfig: parsePluginConfig(
      config.plugins?.entries?.["octo-mail"]?.config ?? {},
    ),
    stateDir: "/tmp/openclaw-test",
    agentId: "support-agent",
    mailboxAddress: "support@example.test",
    spaceId: "space-support",
    apiUrl: "https://octo.example.test",
    wait: false,
    ...overrides,
  };
}

function createConfig(): OpenClawConfig {
  return {
    agents: { list: [{ id: "support-agent" }] },
    bindings: [
      {
        agentId: "support-agent",
        match: { channel: "octo", accountId: "bot-support" },
      },
    ],
    channels: {
      octo: {
        accounts: {
          "bot-support": {
            agentId: "support-agent",
            apiUrl: "https://octo.example.test/api",
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

function createService(statuses: AuthorizationStatusResult[] = []) {
  const pending = [...statuses];
  return {
    start: vi.fn(async () => ({
      status: "authorization_required" as const,
      pluginAccountId: "mail-test",
      userCode: "ABCD",
      verificationUri: "https://octo.example.test/authorize?code=ABCD",
      expiresAt: "2026-08-06T10:10:00.000Z",
      pollIntervalSeconds: 1,
    })),
    check: vi.fn(async () => {
      const result = pending.shift();
      if (result === undefined) {
        throw new Error("unexpected authorization check");
      }
      return result;
    }),
    stop: vi.fn(async () => undefined),
  };
}
