import { describe, expect, it, vi } from "vitest";

import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import { MailClientError } from "../mail/mail-client.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";
import { StoredCredentialActivationWatcher } from "./stored-credential-activation-watcher.js";

describe("stored credential activation watcher", () => {
  it("activates a credential created by another process exactly once", async () => {
    let fingerprint: string | undefined;
    const activate = vi.fn(async () => undefined);
    const watcher = createWatcher({
      getFingerprint: async () => fingerprint,
      activate,
    });
    watcher.start();
    await watcher.checkNow();
    expect(activate).not.toHaveBeenCalled();

    fingerprint = "first";
    await watcher.checkNow();
    await watcher.checkNow();

    expect(activate).toHaveBeenCalledTimes(1);
    await watcher.stop();
  });

  it("reactivates only after the stored credential changes", async () => {
    let fingerprint = "first";
    const activate = vi.fn(async () => undefined);
    const watcher = createWatcher({
      getFingerprint: async () => fingerprint,
      activate,
    });
    watcher.start();
    await watcher.checkNow();
    fingerprint = "second";
    await watcher.checkNow();
    await watcher.checkNow();

    expect(activate).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("coalesces concurrent checks and stops scheduling activation", async () => {
    let resolveFingerprint!: (value: string) => void;
    const fingerprint = new Promise<string>((resolve) => {
      resolveFingerprint = resolve;
    });
    const getFingerprint = vi.fn(() => fingerprint);
    const activate = vi.fn(async () => undefined);
    const watcher = createWatcher({ getFingerprint, activate });
    watcher.start();
    const first = watcher.checkNow();
    const second = watcher.checkNow();
    const stopping = watcher.stop();
    resolveFingerprint("first");
    await Promise.all([first, second, stopping]);

    expect(getFingerprint).toHaveBeenCalledTimes(1);
    expect(activate).not.toHaveBeenCalled();
    await watcher.checkNow();
    expect(getFingerprint).toHaveBeenCalledTimes(1);
  });

  it("does not repeatedly retry the same rejected credential", async () => {
    let fingerprint = "rejected";
    const rejected = new MailClientError({
      code: "unauthorized",
      message: "rejected",
      status: 401,
    });
    const activate = vi.fn(async () => {
      throw rejected;
    });
    const onError = vi.fn();
    const watcher = createWatcher({
      getFingerprint: async () => fingerprint,
      activate,
      onError,
    });
    watcher.start();
    await watcher.checkNow();
    await watcher.checkNow();
    expect(activate).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    fingerprint = "replacement";
    await watcher.checkNow();
    expect(activate).toHaveBeenCalledTimes(2);
    await watcher.stop();
  });

  it("does not suppress a replacement written during a rejected activation", async () => {
    let fingerprint = "rejected";
    const rejected = new MailClientError({
      code: "unauthorized",
      message: "rejected",
      status: 401,
    });
    const attemptedFingerprints: string[] = [];
    const activate = vi.fn(async (_account, attemptedFingerprint: string) => {
      attemptedFingerprints.push(attemptedFingerprint);
      if (attemptedFingerprint === "rejected") {
        fingerprint = "replacement";
        throw rejected;
      }
    });
    const watcher = createWatcher({
      getFingerprint: async () => fingerprint,
      activate,
    });
    watcher.start();

    await watcher.checkNow();
    await watcher.checkNow();

    expect(attemptedFingerprints).toEqual(["rejected", "replacement"]);
    await watcher.stop();
  });

  it("does not activate disabled accounts", async () => {
    const activate = vi.fn(async () => undefined);
    const watcher = new StoredCredentialActivationWatcher({
      listAccounts: () => [{ ...account(), enabled: false }],
      getFingerprint: async () => "stored",
      activate,
      onError: () => undefined,
      intervalMs: 60_000,
    });
    watcher.start();
    await watcher.checkNow();

    expect(activate).not.toHaveBeenCalled();
    await watcher.stop();
  });
});

function createWatcher(overrides: {
  getFingerprint: () => Promise<string | undefined>;
  activate: (
    account: PluginAccountConfig,
    fingerprint: string,
  ) => void | boolean | Promise<void | boolean>;
  onError?: (account: PluginAccountConfig, error: unknown) => void;
}): StoredCredentialActivationWatcher {
  return new StoredCredentialActivationWatcher({
    listAccounts: () => [account()],
    getFingerprint: overrides.getFingerprint,
    activate: overrides.activate,
    onError: overrides.onError ?? (() => undefined),
    intervalMs: 60_000,
  });
}

function account(): PluginAccountConfig {
  return {
    pluginAccountId: "mail_support_test",
    enabled: true,
    agentId: "support-agent",
    botId: "support-bot",
    apiBaseUrl: TEST_OCTO_ORIGIN,
    discovery: { enabled: true, pollIntervalMs: 5_000, maxChanges: 100 },
  };
}
