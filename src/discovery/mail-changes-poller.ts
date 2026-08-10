import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import type { MailDiscoveryClient, MailMessage } from "../mail/mail-client.js";
import { MailClientError } from "../mail/mail-client.js";
import type { AgentDispatcher } from "../openclaw/agent-dispatcher.js";
import {
  appendProcessedEmailId,
  createInitialDiscoveryState,
  type DiscoveryStateStore,
  type DiscoveryState,
} from "./discovery-state-store.js";

export interface MailChangesPollerOptions {
  client: MailDiscoveryClient;
  stateStore: DiscoveryStateStore;
  dispatcher: AgentDispatcher;
  logger: PluginLogger;
  maxChanges: number;
  maxPagesPerRun?: number;
  now?: () => Date;
}

export interface PollRunResult {
  baselineCreated: boolean;
  pagesProcessed: number;
  emailsDispatched: number;
  emailsStoppedAtAutoReplyLimit: number;
}

export class FatalDiscoveryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FatalDiscoveryError";
  }
}

export class MailChangesPoller {
  readonly #options: MailChangesPollerOptions;
  #active = false;

  constructor(options: MailChangesPollerOptions) {
    this.#options = options;
  }

  async pollOnce(signal: AbortSignal): Promise<PollRunResult> {
    if (this.#active) {
      throw new Error("octo-mail poll cannot overlap an active poll");
    }
    this.#active = true;
    try {
      return await this.#pollOnce(signal);
    } finally {
      this.#active = false;
    }
  }

  async #pollOnce(signal: AbortSignal): Promise<PollRunResult> {
    const mailAccountId = await this.#options.client.getMailAccountId(signal);
    const inboxMailboxId = await this.#options.client.getInboxMailboxId(signal);
    let state = await this.#options.stateStore.load();
    if (state === undefined) {
      const currentState =
        await this.#options.client.getCurrentEmailState(signal);
      state = createInitialDiscoveryState(mailAccountId, currentState);
      await this.#options.stateStore.save(state);
      this.#options.logger.info(
        `[octo-mail] mail discovery baseline created at state=${currentState}`,
      );
      return {
        baselineCreated: true,
        pagesProcessed: 0,
        emailsDispatched: 0,
        emailsStoppedAtAutoReplyLimit: 0,
      };
    }
    if (state.mailAccountId !== mailAccountId) {
      throw new FatalDiscoveryError(
        "mail discovery state belongs to a different JMAP mail account",
      );
    }

    let pagesProcessed = 0;
    let emailsDispatched = 0;
    let emailsStoppedAtAutoReplyLimit = 0;
    const maxPages = this.#options.maxPagesPerRun ?? 100;
    while (!signal.aborted && pagesProcessed < maxPages) {
      let changes;
      try {
        changes = await this.#options.client.getEmailChanges(
          state.sinceState,
          this.#options.maxChanges,
          signal,
        );
      } catch (error) {
        if (
          error instanceof MailClientError &&
          error.code === "cannotCalculateChanges"
        ) {
          throw new FatalDiscoveryError(
            "JMAP cannot calculate changes from the saved state",
            { cause: error },
          );
        }
        throw error;
      }
      if (changes.oldState !== state.sinceState) {
        throw new FatalDiscoveryError(
          "JMAP Email/changes oldState does not match the saved state",
        );
      }
      if (
        changes.hasMoreChanges &&
        changes.newState === changes.oldState
      ) {
        throw new FatalDiscoveryError(
          "JMAP Email/changes did not advance a paged state",
        );
      }

      const alreadyProcessed = new Set(state.processedEmailIds);
      const candidateIds = changes.created.filter(
        (emailId) => !alreadyProcessed.has(emailId),
      );
      const messages = await this.#options.client.getMessages(
        candidateIds,
        signal,
      );
      const messagesById = new Map(
        messages.map((message) => [message.emailId, message]),
      );
      for (const emailId of candidateIds) {
        const message = messagesById.get(emailId);
        if (
          message === undefined ||
          !message.mailboxIds.includes(inboxMailboxId)
        ) {
          continue;
        }
        const autoReplyContext =
          await this.#options.client.getAutoReplyContext(emailId, signal);
        if (autoReplyContext.limitReached) {
          this.#options.logger.info(
            `[octo-mail] auto_reply_limit_reached; skipping Agent dispatch for emailId=${emailId}; count=${String(autoReplyContext.autoReplyCount)}; max=${String(autoReplyContext.maxAutoReplyCount)}`,
          );
          emailsStoppedAtAutoReplyLimit += 1;
        } else {
          await this.#dispatchMessage(message, autoReplyContext, signal);
          emailsDispatched += 1;
        }
        state = appendProcessedEmailId(state, emailId);
        await this.#options.stateStore.save(state);
      }

      state = { ...state, sinceState: changes.newState };
      await this.#options.stateStore.save(state);
      pagesProcessed += 1;
      if (!changes.hasMoreChanges) {
        break;
      }
    }

    return {
      baselineCreated: false,
      pagesProcessed,
      emailsDispatched,
      emailsStoppedAtAutoReplyLimit,
    };
  }

  async #dispatchMessage(
    message: MailMessage,
    autoReplyContext: Awaited<
      ReturnType<MailDiscoveryClient["getAutoReplyContext"]>
    >,
    signal: AbortSignal,
  ): Promise<void> {
    const now = this.#options.now ?? (() => new Date());
    await this.#options.dispatcher.dispatch(
      {
        emailId: message.emailId,
        receivedAt: message.receivedAt ?? now().toISOString(),
        autoReplyCount: autoReplyContext.autoReplyCount,
        maxAutoReplyCount: autoReplyContext.maxAutoReplyCount,
        nextReplyIsFinal: autoReplyContext.nextReplyIsFinal,
        automaticSendEnabled: autoReplyContext.enabled,
      },
      signal,
    );
  }
}
