import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import { MailClientError } from "../mail/mail-client.js";

export interface StoredCredentialActivationWatcherOptions {
  listAccounts: () => readonly PluginAccountConfig[];
  getFingerprint: (
    account: PluginAccountConfig,
  ) => Promise<string | undefined>;
  activate: (account: PluginAccountConfig) => void | Promise<void>;
  onError: (account: PluginAccountConfig, error: unknown) => void;
  intervalMs: number;
}

/**
 * Detects credentials atomically written by another OpenClaw process and
 * activates the existing full-Gateway discovery path without sharing secrets
 * or relying on a process-local notification bus.
 */
export class StoredCredentialActivationWatcher {
  readonly #options: StoredCredentialActivationWatcherOptions;
  readonly #observedFingerprints = new Map<string, string>();
  #timer: ReturnType<typeof setInterval> | undefined;
  #checkPromise: Promise<void> | undefined;
  #started = false;

  constructor(options: StoredCredentialActivationWatcherOptions) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new Error("stored credential watch interval must be positive");
    }
    this.#options = options;
  }

  start(): void {
    if (this.#started) {
      throw new Error("stored credential activation watcher already started");
    }
    this.#started = true;
    void this.checkNow();
    this.#timer = setInterval(() => void this.checkNow(), this.#options.intervalMs);
    this.#timer.unref?.();
  }

  async checkNow(): Promise<void> {
    if (!this.#started) return;
    if (this.#checkPromise !== undefined) {
      return await this.#checkPromise;
    }
    const operation = this.#check();
    this.#checkPromise = operation;
    try {
      await operation;
    } finally {
      if (this.#checkPromise === operation) {
        this.#checkPromise = undefined;
      }
    }
  }

  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
    await this.#checkPromise;
    this.#observedFingerprints.clear();
  }

  async #check(): Promise<void> {
    for (const account of this.#options.listAccounts()) {
      if (!this.#started) return;
      if (!account.enabled) continue;
      try {
        const fingerprint = await this.#options.getFingerprint(account);
        if (!this.#started) return;
        if (fingerprint === undefined) {
          this.#observedFingerprints.delete(account.pluginAccountId);
          continue;
        }
        if (
          this.#observedFingerprints.get(account.pluginAccountId) === fingerprint
        ) {
          continue;
        }
        await this.#options.activate(account);
        this.#observedFingerprints.set(account.pluginAccountId, fingerprint);
      } catch (error) {
        if (!this.#started) return;
        if (isRejectedCredential(error)) {
          const fingerprint = await this.#safeFingerprint(account);
          if (fingerprint !== undefined) {
            this.#observedFingerprints.set(account.pluginAccountId, fingerprint);
          }
        }
        this.#options.onError(account, error);
      }
    }
  }

  async #safeFingerprint(
    account: PluginAccountConfig,
  ): Promise<string | undefined> {
    try {
      return await this.#options.getFingerprint(account);
    } catch {
      return undefined;
    }
  }
}

function isRejectedCredential(error: unknown): boolean {
  return (
    error instanceof MailClientError &&
    (error.status === 401 || error.status === 403)
  );
}
