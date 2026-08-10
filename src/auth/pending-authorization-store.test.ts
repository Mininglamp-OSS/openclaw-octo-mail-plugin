import { mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createPendingAuthorization,
  PrivatePendingAuthorizationStore,
} from "./pending-authorization-store.js";
import {
  TEST_MAILBOX_ADDRESS,
  TEST_OCTO_ORIGIN,
} from "../testing/test-values.js";

describe("private pending Agent Mail authorization store", () => {
  it("atomically persists private PKCE state outside ordinary plugin state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-auth-state-"));
    const store = new PrivatePendingAuthorizationStore(stateDir);
    const record = pendingRecord();

    await store.save(record);

    await expect(store.load("support")).resolves.toEqual(record);
    const directory = join(stateDir, "plugins", "octo-mail", "auth-pending");
    const files = await readdir(directory);
    expect(files).toHaveLength(1);
    const filePath = join(directory, files[0]!);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
    const raw = await readFile(filePath, "utf8");
    expect(raw).toContain("device-private-test");
    expect(raw).not.toContain("omb_");

    await store.delete("support");
    await expect(store.load("support")).resolves.toBeUndefined();
  });

  it("fails closed on corrupt private state", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-auth-state-"));
    const store = new PrivatePendingAuthorizationStore(stateDir);
    await store.save(pendingRecord());
    const directory = join(stateDir, "plugins", "octo-mail", "auth-pending");
    const [file] = await readdir(directory);
    await writeFile(join(directory, file!), "{}", "utf8");

    await expect(store.load("support")).rejects.toThrow(/version/);
  });
});

function pendingRecord() {
  return createPendingAuthorization({
    pluginAccountId: "support",
    botId: "bot-support",
    botProfile: "support-profile",
    deviceCode: "device-private-test",
    codeVerifier: "verifier-private-test",
    userCode: "ABCD-EFGH",
    verificationUriComplete:
      `${TEST_OCTO_ORIGIN}/mail/authorize?code=ABCD-EFGH`,
    requestedMailboxAddress: TEST_MAILBOX_ADDRESS,
    spaceId: "space-support",
    createdAt: "2026-08-03T10:00:00.000Z",
    expiresAt: "2026-08-03T10:10:00.000Z",
    intervalSeconds: 5,
  });
}
