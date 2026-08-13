import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";

import type { MailDiscoveryClient } from "../mail/mail-client.js";
import type { AgentDispatcher } from "../openclaw/agent-dispatcher.js";
import {
  createInitialDiscoveryState,
  type DiscoveryState,
  type DiscoveryStateStore,
} from "./discovery-state-store.js";
import { MailChangesPoller } from "./mail-changes-poller.js";

describe("MailChangesPoller account replacement", () => {
  it("re-baselines a replaced Mail Account and dispatches only later mail", async () => {
    let state: DiscoveryState | undefined = createInitialDiscoveryState(
      "mail-account-3",
      "7",
    );
    const stateStore = {
      load: vi.fn(async () => state),
      save: vi.fn(async (next: DiscoveryState) => {
        state = next;
      }),
    } satisfies DiscoveryStateStore;
    const client = {
      getMailAccountId: vi.fn(async () => "mail-account-4"),
      getInboxMailboxId: vi.fn(async () => "inbox-4"),
      getCurrentEmailState: vi.fn(async () => "10"),
      getEmailChanges: vi.fn(async () => ({
        oldState: "10",
        newState: "11",
        hasMoreChanges: false,
        created: ["E11"],
        updated: [],
        destroyed: [],
      })),
      getMessages: vi.fn(async () => [
        {
          emailId: "E11",
          mailboxIds: ["inbox-4"],
          receivedAt: "2026-08-13T10:00:00.000Z",
          from: [{ email: "bob@example.test" }],
          to: [{ email: "qa@example.test" }],
          cc: [],
          subject: "After rebind",
          preview: "Hello",
          hasAttachment: false,
        },
      ]),
      getAutoReplyContext: vi.fn(async () => ({
        enabled: true,
        autoReplyCount: 0,
        automaticSendEnabled: true,
        maxAutoReplyCount: 3,
        nextReplyIsFinal: false,
        limitReached: false,
      })),
    } as unknown as MailDiscoveryClient;
    const dispatch = vi.fn(async () => undefined);
    const log = logger();
    const poller = new MailChangesPoller({
      client,
      stateStore,
      dispatcher: { dispatch } as AgentDispatcher,
      logger: log,
      maxChanges: 100,
    });

    const baseline = await poller.pollOnce(new AbortController().signal);

    expect(baseline).toEqual({
      baselineCreated: true,
      pagesProcessed: 0,
      emailsDispatched: 0,
      emailsStoppedAtAutoReplyLimit: 0,
    });
    expect(state).toEqual({
      version: 1,
      mailAccountId: "mail-account-4",
      sinceState: "10",
      processedEmailIds: [],
    });
    expect(client.getEmailChanges).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("mail account changed; discovery baseline reset"),
    );

    const next = await poller.pollOnce(new AbortController().signal);

    expect(next.emailsDispatched).toBe(1);
    expect(client.getEmailChanges).toHaveBeenCalledWith(
      "10",
      100,
      expect.any(AbortSignal),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ emailId: "E11", automaticSendEnabled: true }),
      expect.any(AbortSignal),
    );
  });
});

function logger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}
