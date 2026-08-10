import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginAccountRuntime } from "../accounts/account-runtime-registry.js";
import type { AccountMailClient } from "../accounts/account-runtime-registry.js";
import {
  AccountDiscoveryManager,
  resolveDiscoveryDelayMs,
} from "./account-discovery-manager.js";
import { MailClientError } from "../mail/mail-client.js";
import type { MailPushDiscoveryClient } from "../mail/mail-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("AccountDiscoveryManager", () => {
  it("backs off repeated discovery failures up to one minute", () => {
    expect(resolveDiscoveryDelayMs(5_000, 0)).toBe(5_000);
    expect(resolveDiscoveryDelayMs(5_000, 1)).toBe(10_000);
    expect(resolveDiscoveryDelayMs(5_000, 3)).toBe(40_000);
    expect(resolveDiscoveryDelayMs(5_000, 10)).toBe(60_000);
  });

  it("stops polling when the stored credential is rejected", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-auth-stop-"));
    temporaryDirectories.push(stateDir);
    const client = {
      getMailAccountId: vi.fn(async () => {
        throw new MailClientError({
          code: "unauthorized",
          message: "revoked",
          status: 401,
        });
      }),
    } as unknown as AccountMailClient;
    const log = logger();
    const manager = new AccountDiscoveryManager({
      logger: log,
      createDispatcher: () => ({ dispatch: vi.fn() }),
    });

    await manager.start(stateDir, [runtime(client)]);
    await vi.waitFor(() =>
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining("invalid or revoked"),
      ),
    );
    expect(client.getMailAccountId).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("creates a baseline and dispatches only later Inbox changes", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-discovery-"));
    temporaryDirectories.push(stateDir);
    let changeReturned = false;
    const client = {
      getMailAccountId: vi.fn(async () => "mail-account"),
      getInboxMailboxId: vi.fn(async () => "inbox"),
      getCurrentEmailState: vi.fn(async () => "1"),
      getEmailChanges: vi.fn(async (sinceState: string) => {
        if (sinceState === "1" && !changeReturned) {
          changeReturned = true;
          return {
            oldState: "1",
            newState: "2",
            hasMoreChanges: false,
            created: ["E2"],
            updated: [],
            destroyed: [],
          };
        }
        return {
          oldState: sinceState,
          newState: sinceState,
          hasMoreChanges: false,
          created: [],
          updated: [],
          destroyed: [],
        };
      }),
      getMessages: vi.fn(async () => [
        {
          emailId: "E2",
          mailboxIds: ["inbox"],
          receivedAt: "2026-08-03T10:00:00.000Z",
          from: [{ email: "sender@example.test" }],
          to: [{ email: "agent@example.test" }],
          cc: [],
          subject: "Hello",
          preview: "Hello",
          hasAttachment: false,
        },
      ]),
      getAutoReplyContext: vi.fn(async () => ({
        enabled: false,
        autoReplyCount: 0,
        automaticSendEnabled: false,
        maxAutoReplyCount: 0,
        nextReplyIsFinal: false,
        limitReached: false,
      })),
    } as unknown as AccountMailClient;
    const dispatch = vi.fn(async () => undefined);
    const manager = new AccountDiscoveryManager({
      logger: logger(),
      createDispatcher: () => ({ dispatch }),
    });

    await manager.start(stateDir, [runtime(client)]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });
    expect(dispatch).toHaveBeenCalledWith(
      {
        emailId: "E2",
        receivedAt: "2026-08-03T10:00:00.000Z",
        autoReplyCount: 0,
        automaticSendEnabled: false,
        maxAutoReplyCount: 0,
        nextReplyIsFinal: false,
      },
      expect.any(AbortSignal),
    );
    await manager.stop();

    await manager.start(stateDir, [runtime(client)]);
    await vi.waitFor(() => expect(client.getEmailChanges).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    await manager.stop();
  });

  it("uses JMAP EventSource as the wake-up signal and Email/changes as authority", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-push-"));
    temporaryDirectories.push(stateDir);
    const client = {
      getMailAccountId: vi.fn(async () => "mail-account"),
      getInboxMailboxId: vi.fn(async () => "inbox"),
      getCurrentEmailState: vi.fn(async () => "1"),
      getEmailChanges: vi.fn(async () => ({
        oldState: "1",
        newState: "2",
        hasMoreChanges: false,
        created: ["E2"],
        updated: [],
        destroyed: [],
      })),
      getMessages: vi.fn(async () => [
        {
          emailId: "E2",
          mailboxIds: ["inbox"],
          receivedAt: "2026-08-07T01:00:00.000Z",
          from: [{ email: "sender@example.test" }],
          to: [{ email: "agent@example.test" }],
          cc: [],
          subject: "Push",
          preview: "Push",
          hasAttachment: false,
        },
      ]),
      getAutoReplyContext: vi.fn(async () => ({
        enabled: false,
        autoReplyCount: 0,
        maxAutoReplyCount: 0,
        nextReplyIsFinal: false,
        limitReached: false,
      })),
      watchEmailStateChanges: vi.fn(
        async (
          onChange: (change: { accountId: string; state: string }) => Promise<void>,
          signal: AbortSignal,
        ) => {
          await onChange({ accountId: "mail-account", state: "2" });
          await new Promise<void>((resolve) =>
            signal.addEventListener("abort", () => resolve(), { once: true }),
          );
        },
      ),
    } as unknown as AccountMailClient & MailPushDiscoveryClient;
    const dispatch = vi.fn(async () => undefined);
    const manager = new AccountDiscoveryManager({
      logger: logger(),
      createDispatcher: () => ({ dispatch }),
    });

    await manager.start(stateDir, [runtime(client)]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(client.watchEmailStateChanges).toHaveBeenCalledTimes(1);
    expect(client.getEmailChanges).toHaveBeenCalledTimes(1);
    await manager.stop();
  });
});

function runtime(client: AccountMailClient): PluginAccountRuntime {
  return {
    config: {
      pluginAccountId: "support",
      enabled: true,
      agentId: "support-agent",
      botId: "bot-support",
      apiBaseUrl: "https://octo.example.test",
      discovery: { enabled: true, pollIntervalMs: 10, maxChanges: 100 },
    },
    client,
    mailboxAddress: "support@example.test",
    mailAccountId: "mail-account",
    inboxMailboxId: "inbox",
  };
}

function logger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
