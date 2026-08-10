import { describe, expect, it, vi } from "vitest";

import {
  AgentMailAuthorizationClient,
  AgentMailAuthorizationError,
} from "./agent-mail-authorization-client.js";
import { createPkcePair } from "./pkce.js";
import {
  TEST_MAILBOX_ADDRESS,
  TEST_OCTO_ORIGIN,
} from "../testing/test-values.js";

describe("Agent Mail device authorization client", () => {
  it("creates a device request with configured Bot identity and no authorization header", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      jsonResponse(200, {
        deviceCode: "device-secret-for-test",
        userCode: "ABCD-EFGH",
        verificationUri: "/mail/authorize",
        verificationUriComplete: "/mail/authorize?code=ABCD-EFGH",
        expiresIn: 600,
        interval: 5,
      }),
    );
    const client = new AgentMailAuthorizationClient({
      baseUrl: TEST_OCTO_ORIGIN,
      fetch: fetchMock as typeof fetch,
    });
    const pkce = createPkcePair(() => new Uint8Array(32).fill(7));

    const result = await client.createDeviceAuthorization({
      botId: "bot-support",
      botProfile: "support-profile",
      mailboxAddress: TEST_MAILBOX_ADDRESS,
      spaceId: "space-support",
      codeChallenge: pkce.challenge,
    });

    expect(result).toMatchObject({
      userCode: "ABCD-EFGH",
      verificationUri:
        `${TEST_OCTO_ORIGIN}/mail/authorize`,
      verificationUriComplete:
        `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
      expiresIn: 600,
      interval: 5,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/webapi/v0/agent-auth/device`,
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(JSON.parse(String(init?.body))).toEqual({
      botId: "bot-support",
      clientName: "openclaw-octo-mail-plugin",
      spaceId: "space-support",
      codeChallenge: pkce.challenge,
      botProfile: "support-profile",
      mailboxAddress: TEST_MAILBOX_ADDRESS,
    });
  });

  it("exchanges the private device proof and validates the mailbox credential shape", async () => {
    const token = testCredential();
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        jsonResponse(200, {
          accessToken: token,
        mailboxAddress: TEST_MAILBOX_ADDRESS,
          botId: "bot-support",
          botProfile: "support-profile",
        }),
    );
    const client = new AgentMailAuthorizationClient({
      baseUrl: TEST_OCTO_ORIGIN,
      fetch: fetchMock as typeof fetch,
    });

    const result = await client.exchangeAuthorization({
      deviceCode: "private-device-code",
      codeVerifier: "private-pkce-verifier",
    });

    expect(result).toEqual({
      accessToken: token,
      mailboxAddress: TEST_MAILBOX_ADDRESS,
      botId: "bot-support",
      botProfile: "support-profile",
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(
      `${TEST_OCTO_ORIGIN}/agent-mail-api/webapi/v0/agent-auth/token`,
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      deviceCode: "private-device-code",
      codeVerifier: "private-pkce-verifier",
    });
  });

  it("preserves the explicit authorization_pending code without exposing request secrets", async () => {
    const client = new AgentMailAuthorizationClient({
      baseUrl: TEST_OCTO_ORIGIN,
      fetch: vi.fn(async () =>
        jsonResponse(400, {
          error: {
            code: "authorization_pending",
            message: "waiting for mailbox authorization",
          },
        }),
      ) as typeof fetch,
    });

    const error = await client
      .exchangeAuthorization({
        deviceCode: "device-private-value",
        codeVerifier: "verifier-private-value",
      })
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AgentMailAuthorizationError);
    expect(error).toMatchObject({
      code: "authorization_pending",
      status: 400,
    });
    expect(String(error)).not.toContain("device-private-value");
    expect(String(error)).not.toContain("verifier-private-value");
  });

  it("fails closed on malformed successful responses", async () => {
    const client = new AgentMailAuthorizationClient({
      baseUrl: TEST_OCTO_ORIGIN,
      fetch: vi.fn(async () =>
        jsonResponse(200, {
          accessToken: "not-an-agent-mail-token",
          mailboxAddress: TEST_MAILBOX_ADDRESS,
          botId: "bot-support",
        }),
      ) as typeof fetch,
    });

    await expect(
      client.exchangeAuthorization({
        deviceCode: "device-code",
        codeVerifier: "code-verifier",
      }),
    ).rejects.toThrow(/omb_/);
  });

  it("rejects invalid mailbox and PKCE inputs before issuing a request", async () => {
    const fetchMock = vi.fn();
    const client = new AgentMailAuthorizationClient({
      baseUrl: TEST_OCTO_ORIGIN,
      fetch: fetchMock as typeof fetch,
    });

    await expect(
      client.createDeviceAuthorization({
        botId: "bot-support",
        mailboxAddress: "not-a-mailbox",
        spaceId: "space-support",
        codeChallenge: "bad",
      }),
    ).rejects.toThrow(/mailboxAddress/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function testCredential(): string {
  return ["omb", "authorization", "client", "test"].join("_");
}
