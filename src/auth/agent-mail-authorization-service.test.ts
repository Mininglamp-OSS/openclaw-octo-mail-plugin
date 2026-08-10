import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import {
  AgentMailAuthorizationClient,
  AgentMailAuthorizationError,
} from "./agent-mail-authorization-client.js";
import { AgentMailAuthorizationService } from "./agent-mail-authorization-service.js";
import type {
  PendingAgentAuthorization,
  PendingAuthorizationStore,
} from "./pending-authorization-store.js";
import {
  TEST_MAILBOX_ADDRESS,
  TEST_OCTO_ORIGIN,
} from "../testing/test-values.js";

describe("Agent Mail authorization service", () => {
  it("starts authorization with trusted account Bot identity and returns no device proof", async () => {
    const store = memoryStore();
    const createDeviceAuthorization = vi.fn(async () => ({
      deviceCode: "private-device",
      userCode: "ABCD-EFGH",
      verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize`,
      verificationUriComplete:
        `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
      expiresIn: 600,
      interval: 5,
    }));
    const service = serviceWith({ store, createDeviceAuthorization });

    const result = await service.start(
      account(),
      TEST_MAILBOX_ADDRESS,
      "space-support",
    );

    expect(createDeviceAuthorization).toHaveBeenCalledWith(
      {
        botId: "bot-support",
        botProfile: "support-profile",
        mailboxAddress: TEST_MAILBOX_ADDRESS,
        spaceId: "space-support",
        codeChallenge: "test-challenge",
      },
      undefined,
    );
    expect(result).toEqual({
      status: "authorization_required",
      pluginAccountId: "support",
      userCode: "ABCD-EFGH",
      verificationUri:
        `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
      expiresAt: "2026-08-03T10:10:00.000Z",
      pollIntervalSeconds: 5,
    });
    expect(JSON.stringify(result)).not.toContain("private-device");
    expect(JSON.stringify(result)).not.toContain("test-verifier");
    expect(store.current).toMatchObject({
      botId: "bot-support",
      deviceCode: "private-device",
      codeVerifier: "test-verifier",
      spaceId: "space-support",
    });
  });

  it("reuses an unexpired pending request for the same mailbox", async () => {
    const store = memoryStore(pending());
    const createDeviceAuthorization = vi.fn();
    const service = serviceWith({ store, createDeviceAuthorization });

    const result = await service.start(
      account(),
      TEST_MAILBOX_ADDRESS.toUpperCase(),
      "space-support",
    );

    expect(result).toEqual({
      status: "authorization_required",
      pluginAccountId: "support",
      userCode: "ABCD-EFGH",
      verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
      expiresAt: "2026-08-03T10:10:00.000Z",
      pollIntervalSeconds: 5,
    });
    expect(createDeviceAuthorization).not.toHaveBeenCalled();
    expect(store.current?.deviceCode).toBe("private-device");
    await service.stop();
  });

  it("creates a new request when the pending request targets another mailbox", async () => {
    const store = memoryStore(pending());
    const createDeviceAuthorization = vi.fn(async () => ({
      deviceCode: "new-private-device",
      userCode: "WXYZ-1234",
      verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize`,
      verificationUriComplete:
        `${TEST_OCTO_ORIGIN}/mail/authorize?code=WXYZ-1234`,
      expiresIn: 600,
      interval: 5,
    }));
    const service = serviceWith({ store, createDeviceAuthorization });

    await service.start(account(), "other@example.test", "space-support");

    expect(createDeviceAuthorization).toHaveBeenCalledTimes(1);
    expect(store.current).toMatchObject({
      requestedMailboxAddress: "other@example.test",
      deviceCode: "new-private-device",
    });
    await service.stop();
  });

  it("creates a new request when the pending request belongs to another Space", async () => {
    const store = memoryStore(pending());
    const createDeviceAuthorization = vi.fn(async () => ({
      deviceCode: "new-space-device",
      userCode: "SPACE-1234",
      verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize`,
      verificationUriComplete:
        `${TEST_OCTO_ORIGIN}/mail/authorize?code=SPACE-1234&space_id=space-other`,
      expiresIn: 600,
      interval: 5,
    }));
    const service = serviceWith({ store, createDeviceAuthorization });

    await service.start(account(), TEST_MAILBOX_ADDRESS, "space-other");

    expect(createDeviceAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ spaceId: "space-other" }),
      undefined,
    );
    expect(store.current).toMatchObject({
      deviceCode: "new-space-device",
      spaceId: "space-other",
    });
    await service.stop();
  });

  it("keeps a pending request private and returns an explicit pending status", async () => {
    const store = memoryStore(pending());
    const service = serviceWith({
      store,
      exchangeAuthorization: vi.fn(async () => {
        throw new AgentMailAuthorizationError({
          code: "authorization_pending",
          message: "waiting",
          status: 400,
        });
      }),
    });

    const result = await service.check(account());

    expect(result.status).toBe("pending");
    expect(JSON.stringify(result)).not.toContain("private-device");
    expect(store.current).toBeDefined();
  });

  it("stores a credential only after returned Bot identity matches", async () => {
    const store = memoryStore(pending());
    const storeCredential = vi.fn(async () => undefined);
    const onCredentialStored = vi.fn();
    const token = testCredential();
    const service = serviceWith({
      store,
      storeCredential,
      onCredentialStored,
      exchangeAuthorization: vi.fn(async () => ({
        accessToken: token,
        mailboxAddress: TEST_MAILBOX_ADDRESS,
        botId: "bot-support",
        botProfile: "support-profile",
      })),
    });

    const result = await service.check(account());

    expect(result).toEqual({
      status: "connected",
      pluginAccountId: "support",
      mailboxAddress: TEST_MAILBOX_ADDRESS,
    });
    expect(storeCredential).toHaveBeenCalledWith(account(), token);
    expect(onCredentialStored).toHaveBeenCalledWith(account(), token);
    expect(store.current).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("omb_");
  });

  it("automatically completes an approved authorization after the polling interval", async () => {
    const store = memoryStore();
    const storeCredential = vi.fn(async () => undefined);
    const onCredentialStored = vi.fn();
    let releaseSleep: (() => void) | undefined;
    const sleep = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
    );
    const service = serviceWith({
      store,
      sleep,
      storeCredential,
      onCredentialStored,
      createDeviceAuthorization: vi.fn(async () => ({
        deviceCode: "private-device",
        userCode: "ABCD-EFGH",
        verificationUri: `${TEST_OCTO_ORIGIN}/mail/authorize`,
        verificationUriComplete:
          `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
        expiresIn: 600,
        interval: 5,
      })),
      exchangeAuthorization: vi.fn(async () => ({
        accessToken: testCredential(),
        mailboxAddress: TEST_MAILBOX_ADDRESS,
        botId: "bot-support",
        botProfile: "support-profile",
      })),
    });

    await service.start(account(), TEST_MAILBOX_ADDRESS, "space-support");
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledWith(5_000, expect.any(AbortSignal)));
    releaseSleep?.();

    await vi.waitFor(() => expect(onCredentialStored).toHaveBeenCalledTimes(1));
    expect(storeCredential).toHaveBeenCalledWith(account(), testCredential());
    expect(store.current).toBeUndefined();
    await expect(service.check(account())).resolves.toEqual({
      status: "connected",
      pluginAccountId: "support",
      mailboxAddress: TEST_MAILBOX_ADDRESS,
    });
    await service.stop();
  });

  it("resumes a pending authorization after Runtime restart", async () => {
    const store = memoryStore(pending());
    let releaseSleep: (() => void) | undefined;
    const onCredentialStored = vi.fn();
    const service = serviceWith({
      store,
      sleep: async () =>
        await new Promise<void>((resolve) => {
          releaseSleep = resolve;
        }),
      onCredentialStored,
      exchangeAuthorization: vi.fn(async () => ({
        accessToken: testCredential(),
        mailboxAddress: TEST_MAILBOX_ADDRESS,
        botId: "bot-support",
        botProfile: "support-profile",
      })),
    });

    await service.resumePending([account()]);
    await vi.waitFor(() => expect(releaseSleep).toBeTypeOf("function"));
    releaseSleep?.();

    await vi.waitFor(() => expect(onCredentialStored).toHaveBeenCalledTimes(1));
    expect(store.current).toBeUndefined();
    await service.stop();
  });

  it("rejects and discards a token issued for another Bot", async () => {
    const store = memoryStore(pending());
    const storeCredential = vi.fn(async () => undefined);
    const service = serviceWith({
      store,
      storeCredential,
      exchangeAuthorization: vi.fn(async () => ({
        accessToken: testCredential(),
        mailboxAddress: TEST_MAILBOX_ADDRESS,
        botId: "bot-other",
        botProfile: "support-profile",
      })),
    });

    await expect(service.check(account())).rejects.toThrow(/another Bot/);
    expect(storeCredential).not.toHaveBeenCalled();
    expect(store.current).toBeUndefined();
  });

  it("expires local pending proof without sending it to the server", async () => {
    const record = pending();
    record.expiresAt = "2026-08-03T09:59:59.000Z";
    const store = memoryStore(record);
    const exchangeAuthorization = vi.fn();
    const service = serviceWith({ store, exchangeAuthorization });

    await expect(service.check(account())).resolves.toEqual({
      status: "expired",
      pluginAccountId: "support",
    });
    expect(exchangeAuthorization).not.toHaveBeenCalled();
    expect(store.current).toBeUndefined();
  });
});

function serviceWith(options: {
  store: MemoryStore;
  createDeviceAuthorization?: AgentMailAuthorizationClient["createDeviceAuthorization"];
  exchangeAuthorization?: AgentMailAuthorizationClient["exchangeAuthorization"];
  storeCredential?: (
    account: PluginAccountConfig,
    credential: string,
  ) => Promise<void>;
  onCredentialStored?: (
    account: PluginAccountConfig,
    credential: string,
  ) => void | Promise<void>;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onBackgroundError?: (
    account: PluginAccountConfig,
    error: unknown,
  ) => void;
}): AgentMailAuthorizationService {
  const client = {
    createDeviceAuthorization:
      options.createDeviceAuthorization ?? vi.fn(),
    exchangeAuthorization: options.exchangeAuthorization ?? vi.fn(),
  } as unknown as AgentMailAuthorizationClient;
  return new AgentMailAuthorizationService({
    config: {} as OpenClawConfig,
    stateDir: "/tmp/test",
    pendingStore: options.store,
    createClient: () => client,
    createPkce: () => ({
      verifier: "test-verifier",
      challenge: "test-challenge",
    }),
    storeCredential: options.storeCredential ?? vi.fn(async () => undefined),
    onCredentialStored: options.onCredentialStored ?? vi.fn(),
    now: () => new Date("2026-08-03T10:00:00.000Z"),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep }),
    ...(options.onBackgroundError === undefined
      ? {}
      : { onBackgroundError: options.onBackgroundError }),
  });
}

interface MemoryStore extends PendingAuthorizationStore {
  current: PendingAgentAuthorization | undefined;
}

function memoryStore(initial?: PendingAgentAuthorization): MemoryStore {
  return {
    current: initial,
    async save(record) {
      this.current = record;
    },
    async load() {
      return this.current;
    },
    async delete() {
      this.current = undefined;
    },
  };
}

function account(): PluginAccountConfig {
  return {
    pluginAccountId: "support",
    enabled: true,
    agentId: "support-agent",
    botId: "bot-support",
    botProfile: "support-profile",
    apiBaseUrl: TEST_OCTO_ORIGIN,
    credentialRef: {
      source: "file",
      provider: "support_mail",
      id: "value",
    },
    discovery: { enabled: true, pollIntervalMs: 5_000, maxChanges: 100 },
  };
}

function pending(): PendingAgentAuthorization {
  return {
    version: 1,
    pluginAccountId: "support",
    botId: "bot-support",
    botProfile: "support-profile",
    deviceCode: "private-device",
    codeVerifier: "private-verifier",
    userCode: "ABCD-EFGH",
    verificationUriComplete:
      `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
    requestedMailboxAddress: TEST_MAILBOX_ADDRESS,
    spaceId: "space-support",
    createdAt: "2026-08-03T10:00:00.000Z",
    expiresAt: "2026-08-03T10:10:00.000Z",
    intervalSeconds: 5,
  };
}

function testCredential(): string {
  return ["omb", "authorization", "service", "test"].join("_");
}
