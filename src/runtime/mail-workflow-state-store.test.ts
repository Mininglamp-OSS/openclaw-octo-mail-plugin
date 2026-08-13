import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FileMailWorkflowStateStore } from "./mail-workflow-state-store.js";

describe("FileMailWorkflowStateStore", () => {
  it("persists one current Draft per session and clears without deleting the Draft", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-mail-workflow-"));
    const path = join(directory, "state.json");
    const store = new FileMailWorkflowStateStore(path);
    const pending = {
      sessionKey: "agent:a:octo:b:direct:u",
      agentId: "a",
      pluginAccountId: "support",
      mailAccountId: "42",
      draftId: "E7",
      draftVersion: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
    };

    await store.savePending(pending);
    await expect(
      new FileMailWorkflowStateStore(path).getPending(pending.sessionKey),
    ).resolves.toEqual(pending);
    await expect(store.clearPending(pending)).resolves.toEqual(pending);
    await expect(store.getPending(pending.sessionKey)).resolves.toBeUndefined();
    expect((await readFile(path, "utf8")).toString()).not.toContain("omb_");
  });

  it("does not clear a newer Draft saved for the same session", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-mail-workflow-race-"));
    const store = new FileMailWorkflowStateStore(join(directory, "state.json"));
    const first = {
      sessionKey: "agent:a:octo:b:direct:u",
      agentId: "a",
      pluginAccountId: "support",
      mailAccountId: "42",
      draftId: "E7",
      draftVersion: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
    };
    const replacement = {
      ...first,
      draftId: "E8",
      draftVersion: 2,
      createdAt: "2026-08-08T00:01:00.000Z",
    };

    await store.savePending(first);
    await store.savePending(replacement);
    await expect(store.clearPending(first)).resolves.toBeUndefined();
    await expect(store.getPending(first.sessionKey)).resolves.toEqual(replacement);
  });

  it("loads legacy pending confirmations without a persisted mail account id", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-mail-workflow-legacy-"));
    const path = join(directory, "state.json");
    const pending = {
      sessionKey: "agent:a:octo:b:direct:u",
      agentId: "a",
      pluginAccountId: "support",
      draftId: "E7",
      draftVersion: 1,
      createdAt: "2026-08-08T00:00:00.000Z",
    };
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        pendingBySession: { [pending.sessionKey]: pending },
        deliveredNotificationIds: [],
      })}\n`,
      "utf8",
    );

    await expect(
      new FileMailWorkflowStateStore(path).getPending(pending.sessionKey),
    ).resolves.toEqual(pending);
  });

  it("deduplicates delivered owner notifications", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-mail-notify-"));
    const store = new FileMailWorkflowStateStore(join(directory, "state.json"));
    await expect(store.notificationDelivered("notification-1")).resolves.toBe(
      false,
    );
    await store.markNotificationDelivered("notification-1");
    await store.markNotificationDelivered("notification-1");
    await expect(store.notificationDelivered("notification-1")).resolves.toBe(
      true,
    );
  });
});
