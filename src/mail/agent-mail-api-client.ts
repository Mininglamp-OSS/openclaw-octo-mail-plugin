import { createHash } from "node:crypto";

import {
  MailClientError,
  type MailAddress,
  type MailClient,
  type MailIdentityClient,
  type MailEmailStateChange,
  type MailAutoReplyContext,
  type MailAutoReplyResult,
  type EmailChangesPage,
  type MailDiscoveryClient,
  type MailDraftDeliveryClient,
  type MailMessage,
  type MailOwnerConfirmationRequired,
  type MailOwnerReviewRequired,
  type MailSendInput,
  type MailWriteResult,
  type MailWriteAccepted,
} from "./mail-client.js";
import {
  consumeJmapEventSource,
  expandJmapEventSourceUrl,
} from "./jmap-event-source.js";
import { normalizeOctoOrigin } from "./octo-origin.js";

const JMAP_CORE = "urn:ietf:params:jmap:core";
const JMAP_MAIL = "urn:ietf:params:jmap:mail";
const JMAP_SESSION_PATH = "/agent-mail-api/.well-known/jmap";
const IDENTITY_PATH = "/agent-mail-api/webapi/v0/identity";
const AUTOMATION_HEADER = "X-Octo-Automation";
const IDEMPOTENCY_HEADER = "X-Octo-Idempotency-Key";
const MAX_JSON_RESPONSE_CHARS = 8 * 1024 * 1024;

type FetchLike = typeof fetch;

export interface AgentMailApiClientOptions {
  baseUrl: string;
  credential: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  eventSourceMaxConnectionMs?: number;
}

interface JsonResponse {
  status: number;
  ok: boolean;
  body: Record<string, unknown>;
}

interface JmapSessionInfo {
  accountId: string;
  apiUrl: string;
  eventSourceUrl: string;
}

export class AgentMailApiClient
  implements
    MailClient,
    MailDiscoveryClient,
    MailIdentityClient,
    MailDraftDeliveryClient
{
  readonly #origin: string;
  readonly #credential: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;
  readonly #eventSourceMaxConnectionMs: number;
  #sessionPromise: Promise<JmapSessionInfo> | undefined;
  #inboxMailboxIdPromise: Promise<string> | undefined;

  constructor(options: AgentMailApiClientOptions) {
    this.#origin = normalizeOctoOrigin(options.baseUrl);
    if (!options.credential.startsWith("omb_")) {
      throw new Error("Agent Mail API credential must use the omb_ scheme");
    }
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error("Agent Mail API timeoutMs must be a positive integer");
    }
    this.#eventSourceMaxConnectionMs =
      options.eventSourceMaxConnectionMs ?? 300_000;
    if (
      !Number.isInteger(this.#eventSourceMaxConnectionMs) ||
      this.#eventSourceMaxConnectionMs <= 0
    ) {
      throw new Error(
        "Agent Mail API eventSourceMaxConnectionMs must be a positive integer",
      );
    }
  }

  async getMessage(
    emailId: string,
    signal?: AbortSignal,
  ): Promise<MailMessage> {
    requireNonEmpty(emailId, "emailId");
    const messages = await this.getMessages([emailId], signal);
    const message = messages.find((item) => item.emailId === emailId);
    if (message === undefined) {
      throw new MailClientError({
        code: "email_not_found",
        message: `Email ${emailId} was not found`,
      });
    }
    return message;
  }

  async getIdentityAddress(signal?: AbortSignal): Promise<string> {
    const response = await this.#requestJson(
      IDENTITY_PATH,
      { method: "GET" },
      signal,
      "not-sent",
    );
    if (!response.ok) {
      throw httpResponseError(response);
    }
    return requireMailboxList(
      [readRequiredString(response.body, "address")],
      "identity address",
      true,
    )[0]!;
  }

  async getMessages(
    emailIds: string[],
    signal?: AbortSignal,
  ): Promise<MailMessage[]> {
    if (emailIds.length === 0) {
      return [];
    }
    if (emailIds.length > 1_000) {
      throw new MailClientError({
        code: "too_many_email_ids",
        message: "Email/get POC batch exceeds 1000 ids",
      });
    }
    for (const emailId of emailIds) {
      requireNonEmpty(emailId, "emailId");
    }
    const accountId = await this.getMailAccountId(signal);
    const response = await this.#callJmap(
      "Email/get",
      { accountId, ids: emailIds },
      signal,
    );
    const list = readArray(response, "list");
    const requested = new Set(emailIds);
    const messages: MailMessage[] = [];
    for (const item of list) {
      if (!isRecord(item) || typeof item["id"] !== "string") {
        throw invalidJmapResponse("Email/get returned a malformed email");
      }
      if (!requested.has(item["id"])) {
        throw invalidJmapResponse("Email/get returned an unrequested email");
      }
      messages.push(parseMailMessage(item, item["id"]));
    }
    readStrictStringArray(response, "notFound");
    return messages;
  }

  async getMailAccountId(signal?: AbortSignal): Promise<string> {
    return (await this.#jmapSession(signal)).accountId;
  }

  async watchEmailStateChanges(
    onChange: (change: MailEmailStateChange) => Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    const session = await this.#jmapSession(signal);
    const eventSourceUrl = this.#resolveTrustedJmapUrl(
      expandJmapEventSourceUrl(session.eventSourceUrl, {
        types: "Email",
        closeafter: "no",
        ping: 30,
      }),
    );
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abortFromCaller, { once: true });
    let recycled = false;
    const recycleTimer = setTimeout(() => {
      recycled = true;
      controller.abort(new Error("JMAP EventSource connection recycled"));
    }, this.#eventSourceMaxConnectionMs);
    recycleTimer.unref?.();
    const cleanup = () => {
      clearTimeout(recycleTimer);
      signal.removeEventListener("abort", abortFromCaller);
    };

    let response: Response;
    try {
      response = await this.#fetch(eventSourceUrl, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${this.#credential}`,
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (cause) {
      cleanup();
      if (signal.aborted || recycled) {
        return;
      }
      throw new MailClientError({
        code: "event_source_transport_failure",
        message: "JMAP EventSource connection failed",
        cause,
      });
    }

    try {
      if (!response.ok) {
        throw new MailClientError({
          code:
            response.status === 401
              ? "unauthorized"
              : response.status === 403
                ? "forbidden"
                : "event_source_http_error",
          message: `JMAP EventSource returned HTTP ${String(response.status)}`,
          status: response.status,
        });
      }
      if (
        !response.headers
          .get("Content-Type")
          ?.toLowerCase()
          .startsWith("text/event-stream")
      ) {
        throw new MailClientError({
          code: "invalid_jmap_event_source",
          message: "JMAP EventSource did not return text/event-stream",
        });
      }
      if (response.body === null) {
        throw new MailClientError({
          code: "invalid_jmap_event_source",
          message: "JMAP EventSource returned no response body",
        });
      }
      try {
        await consumeJmapEventSource(
          response.body,
          session.accountId,
          onChange,
          controller.signal,
        );
      } catch (cause) {
        if (signal.aborted || recycled) {
          return;
        }
        throw cause;
      }
      if (!signal.aborted && !recycled) {
        throw new MailClientError({
          code: "event_source_closed",
          message: "JMAP EventSource closed unexpectedly",
        });
      }
    } finally {
      cleanup();
    }
  }

  async getInboxMailboxId(signal?: AbortSignal): Promise<string> {
    if (this.#inboxMailboxIdPromise === undefined) {
      this.#inboxMailboxIdPromise = this.#loadInboxMailboxId(signal).catch(
        (error: unknown) => {
          this.#inboxMailboxIdPromise = undefined;
          throw error;
        },
      );
    }
    return this.#inboxMailboxIdPromise;
  }

  async getCurrentEmailState(signal?: AbortSignal): Promise<string> {
    const accountId = await this.getMailAccountId(signal);
    const response = await this.#callJmap(
      "Email/get",
      { accountId, ids: [] },
      signal,
    );
    return readRequiredState(response, "state");
  }

  async getEmailChanges(
    sinceState: string,
    maxChanges: number,
    signal?: AbortSignal,
  ): Promise<EmailChangesPage> {
    requireState(sinceState, "sinceState");
    if (!Number.isInteger(maxChanges) || maxChanges <= 0 || maxChanges > 1_000) {
      throw new MailClientError({
        code: "invalid_argument",
        message: "maxChanges must be an integer from 1 to 1000",
      });
    }
    const accountId = await this.getMailAccountId(signal);
    const response = await this.#callJmap(
      "Email/changes",
      { accountId, sinceState, maxChanges },
      signal,
    );
    return {
      oldState: readRequiredState(response, "oldState"),
      newState: readRequiredState(response, "newState"),
      hasMoreChanges: readRequiredBoolean(response, "hasMoreChanges"),
      created: readStrictStringArray(response, "created"),
      updated: readStrictStringArray(response, "updated"),
      destroyed: readStrictStringArray(response, "destroyed"),
    };
  }

  async getAutoReplyContext(
    emailId: string,
    signal?: AbortSignal,
  ): Promise<MailAutoReplyContext> {
    requireNonEmpty(emailId, "emailId");
    const response = await this.#requestJson(
      `/agent-mail-api/webapi/v0/messages/${encodeURIComponent(emailId)}/auto-reply-context`,
      { method: "GET" },
      signal,
      "not-sent",
    );
    if (!response.ok) {
      throw httpResponseError(response);
    }
    const enabled = readRequiredJsonBoolean(response.body, "enabled");
    const autoReplyCount = readNonNegativeInteger(
      response.body,
      "autoReplyCount",
    );
    const maxAutoReplyCount = readNonNegativeInteger(
      response.body,
      "maxAutoReplyCount",
    );
    const nextReplyIsFinal = readRequiredJsonBoolean(
      response.body,
      "nextReplyIsFinal",
    );
    const limitReached = readRequiredJsonBoolean(response.body, "limitReached");
    if (
      (enabled && maxAutoReplyCount <= 0) ||
      (!enabled &&
        (autoReplyCount !== 0 ||
          maxAutoReplyCount !== 0 ||
          nextReplyIsFinal ||
          limitReached)) ||
      autoReplyCount > maxAutoReplyCount ||
      (limitReached && autoReplyCount < maxAutoReplyCount) ||
      (nextReplyIsFinal && autoReplyCount + 1 !== maxAutoReplyCount)
    ) {
      throw invalidJsonResponse("Agent Mail returned an inconsistent automatic-reply context");
    }
    return {
      enabled,
      autoReplyCount,
      maxAutoReplyCount,
      nextReplyIsFinal,
      limitReached,
    };
  }

  async reply(
    emailId: string,
    text: string,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailWriteResult> {
    requireNonEmpty(emailId, "emailId");
    requireNonEmpty(text, "reply text");

    const requestBody = JSON.stringify({ text });
    const response = await this.#requestJson(
      `/agent-mail-api/webapi/v0/messages/${encodeURIComponent(emailId)}/reply-draft`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IDEMPOTENCY_HEADER]: outboundIdempotencyKey(
            intentId ?? `manual-reply:${emailId}:${requestBody}`,
          ),
        },
        body: requestBody,
      },
      signal,
      "not-sent",
    );
    if (isOwnerReviewRequired(response)) {
      return parseOwnerReviewRequired(response.body);
    }
    return parsePreparedAgentDraftResponse(response);
  }

  async send(
    input: MailSendInput,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailWriteResult> {
    const to = requireMailboxList(input.to, "to", true);
    const cc = requireMailboxList(input.cc ?? [], "cc", false);
    const bcc = requireMailboxList(input.bcc ?? [], "bcc", false);
    const subject = requireBoundedString(input.subject, "subject", 998, false);
    const text = requireBoundedString(input.text, "message text", 100_000, false);
    const requestBody = JSON.stringify({
      to,
      ...(cc.length === 0 ? {} : { cc }),
      ...(bcc.length === 0 ? {} : { bcc }),
      subject,
      text,
    });
    const response = await this.#requestJson(
      "/agent-mail-api/webapi/v0/agent-send-intents",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [IDEMPOTENCY_HEADER]: outboundIdempotencyKey(
            intentId ?? `manual-send:${requestBody}`,
          ),
        },
        body: requestBody,
      },
      signal,
      // The server reads the binding's current mode atomically with this
      // intent. A transport timeout may therefore hide an accepted send.
      "unknown",
    );
    if (isOwnerReviewRequired(response)) {
      return parseOwnerReviewRequired(response.body);
    }
    if (response.status === 201) {
      return parsePreparedAgentDraftResponse(response);
    }
    if (response.status !== 202) {
      throw new MailClientError({
        code: readServerErrorCode(response.body),
        message: readServerErrorMessage(response.body),
        status: response.status,
        outcome: response.status >= 500 ? "unknown" : "not-sent",
      });
    }
    return parseAcceptedWrite(response.body);
  }

  async replyAutomatically(
    emailId: string,
    text: string,
    signal?: AbortSignal,
    intentId?: string,
  ): Promise<MailAutoReplyResult> {
    requireNonEmpty(emailId, "emailId");
    requireNonEmpty(text, "reply text");
    const response = await this.#requestJson(
      `/agent-mail-api/webapi/v0/messages/${encodeURIComponent(emailId)}/reply`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTOMATION_HEADER]: "auto-reply",
          [IDEMPOTENCY_HEADER]: outboundIdempotencyKey(
            intentId ?? `auto-reply:${emailId}`,
          ),
        },
        body: JSON.stringify({ text }),
      },
      signal,
      "unknown",
    );
    if (isOwnerReviewRequired(response)) {
      return parseOwnerReviewRequired(response.body);
    }
    if (
      response.status === 409 &&
      readServerErrorCode(response.body) === "auto_reply_limit_reached"
    ) {
      return {
        outcome: "auto_reply_stopped",
        reason: "max_auto_replies_reached",
      };
    }
    if (response.status !== 202) {
      throw new MailClientError({
        code: readServerErrorCode(response.body),
        message: readServerErrorMessage(response.body),
        status: response.status,
        outcome: response.status >= 500 ? "unknown" : "not-sent",
      });
    }
    return parseAcceptedWrite(response.body);
  }

  async sendPreparedDraft(
    draftId: string,
    draftVersion: number,
    signal?: AbortSignal,
  ): Promise<MailWriteAccepted> {
    requireNonEmpty(draftId, "draftId");
    if (!Number.isSafeInteger(draftVersion) || draftVersion <= 0) {
      throw new MailClientError({
        code: "invalid_argument",
        message: "draftVersion must be a positive integer",
      });
    }
    const response = await this.#requestJson(
      `/agent-mail-api/webapi/v0/drafts/${encodeURIComponent(draftId)}/send`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTOMATION_HEADER]: "owner-confirmed-draft",
          [IDEMPOTENCY_HEADER]: outboundIdempotencyKey(
            `owner-confirmed-draft:${draftId}:${String(draftVersion)}`,
          ),
        },
        body: JSON.stringify({ draftVersion }),
      },
      signal,
      "unknown",
    );
    if (response.status !== 202) {
      throw new MailClientError({
        code: readServerErrorCode(response.body),
        message: readServerErrorMessage(response.body),
        status: response.status,
        outcome: response.status >= 500 ? "unknown" : "not-sent",
      });
    }
    return parseAcceptedWrite(response.body);
  }

  async #jmapSession(signal?: AbortSignal): Promise<JmapSessionInfo> {
    if (this.#sessionPromise === undefined) {
      this.#sessionPromise = this.#loadJmapSession(signal).catch(
        (error: unknown) => {
          this.#sessionPromise = undefined;
          throw error;
        },
      );
    }
    return this.#sessionPromise;
  }

  async #loadJmapSession(signal?: AbortSignal): Promise<JmapSessionInfo> {
    const response = await this.#requestJson(
      JMAP_SESSION_PATH,
      { method: "GET" },
      signal,
      "not-sent",
    );
    if (!response.ok) {
      throw httpResponseError(response);
    }
    const capabilities = readRecord(response.body, "capabilities");
    if (
      !isRecord(capabilities[JMAP_CORE]) ||
      !isRecord(capabilities[JMAP_MAIL])
    ) {
      throw new MailClientError({
        code: "jmap_mail_unavailable",
        message: "JMAP session does not advertise Core and Mail capabilities",
      });
    }
    const primaryAccounts = readRecord(response.body, "primaryAccounts");
    const accountId = primaryAccounts[JMAP_MAIL];
    if (typeof accountId !== "string" || accountId.length === 0) {
      throw new MailClientError({
        code: "jmap_mail_unavailable",
        message: "JMAP session has no primary Mail account",
      });
    }
    const apiUrl = this.#resolveTrustedJmapUrl(
      readRequiredString(response.body, "apiUrl"),
    );
    const eventSourceUrl = readRequiredString(
      response.body,
      "eventSourceUrl",
    );
    // Validate the expanded origin now so a malicious Session response cannot
    // exfiltrate the omb_ credential when push starts later.
    this.#resolveTrustedJmapUrl(
      expandJmapEventSourceUrl(eventSourceUrl, {
        types: "Email",
        closeafter: "no",
        ping: 30,
      }),
    );
    return { accountId, apiUrl, eventSourceUrl };
  }

  async #loadInboxMailboxId(signal?: AbortSignal): Promise<string> {
    const accountId = await this.getMailAccountId(signal);
    const response = await this.#callJmap(
      "Mailbox/get",
      { accountId },
      signal,
    );
    const list = readArray(response, "list");
    const inboxes = list.filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item["role"] === "inbox",
    );
    if (inboxes.length !== 1) {
      throw new MailClientError({
        code: "inbox_mailbox_ambiguous",
        message: "JMAP account must expose exactly one Inbox mailbox",
      });
    }
    return readRequiredString(inboxes[0]!, "id");
  }

  async #callJmap(
    method: string,
    argumentsValue: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const session = await this.#jmapSession(signal);
    const response = await this.#requestJson(
      session.apiUrl,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          using: [JMAP_CORE, JMAP_MAIL],
          methodCalls: [[method, argumentsValue, "octo-mail-plugin"]],
        }),
      },
      signal,
      "not-sent",
    );
    if (!response.ok) {
      throw httpResponseError(response);
    }

    const methodResponses = readArray(response.body, "methodResponses");
    if (methodResponses.length !== 1 || !Array.isArray(methodResponses[0])) {
      throw invalidJmapResponse("JMAP response must contain one method response");
    }
    const tuple = methodResponses[0];
    const responseName = tuple[0];
    const responseArguments = tuple[1];
    if (typeof responseName !== "string" || !isRecord(responseArguments)) {
      throw invalidJmapResponse("JMAP method response is malformed");
    }
    if (responseName === "error") {
      const code = readOptionalString(responseArguments["type"]);
      const description = readOptionalString(responseArguments["description"]);
      throw new MailClientError({
        code: code || "jmap_error",
        message: description || "JMAP method failed",
      });
    }
    if (responseName !== method) {
      throw invalidJmapResponse("JMAP returned an unexpected method response");
    }
    return responseArguments;
  }

  async #requestJson(
    target: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    transportFailureOutcome: "not-sent" | "unknown",
  ): Promise<JsonResponse> {
    if (signal?.aborted === true) {
      throw new MailClientError({
        code: "request_aborted",
        message: "Agent Mail request was aborted before it started",
      });
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Agent Mail request timed out")),
      this.#timeoutMs,
    );

    let response: Response;
    let raw: string;
    try {
      response = await this.#fetch(this.#resolveTrustedJmapUrl(target), {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.#credential}`,
          ...init.headers,
        },
        signal: controller.signal,
        redirect: "error",
      });
      raw = await response.text();
    } catch (cause) {
      throw new MailClientError({
        code: "transport_failure",
        message:
          transportFailureOutcome === "unknown"
            ? "Agent Mail write result is unknown; inspect Sent before retrying"
            : "Agent Mail request failed before a confirmed write",
        outcome: transportFailureOutcome,
        cause,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }

    if (raw.length > MAX_JSON_RESPONSE_CHARS) {
      throw new MailClientError({
        code: "response_too_large",
        message: "Agent Mail response exceeded the POC JSON limit",
        status: response.status,
        outcome: transportFailureOutcome,
      });
    }
    let body: unknown = {};
    if (raw.trim().length > 0) {
      try {
        body = JSON.parse(raw);
      } catch (cause) {
        if (!response.ok) {
          throw nonJsonHttpResponseError(response.status, cause);
        }
        throw new MailClientError({
          code: "invalid_json_response",
          message: "Agent Mail returned invalid JSON",
          status: response.status,
          outcome: transportFailureOutcome,
          cause,
        });
      }
    }
    if (!isRecord(body)) {
      throw new MailClientError({
        code: "invalid_json_response",
        message: "Agent Mail returned a non-object JSON response",
        status: response.status,
        outcome: transportFailureOutcome,
      });
    }
    return { status: response.status, ok: response.ok, body };
  }

  #resolveTrustedJmapUrl(target: string): string {
    let url: URL;
    try {
      url = new URL(target, this.#origin);
    } catch (cause) {
      throw new MailClientError({
        code: "invalid_jmap_session",
        message: "JMAP Session returned an invalid resource URL",
        cause,
      });
    }
    if (url.origin !== this.#origin) {
      throw new MailClientError({
        code: "untrusted_jmap_resource_url",
        message: "JMAP Session resource URL must use the configured OCTO origin",
      });
    }
    return url.toString();
  }
}

function nonJsonHttpResponseError(
  status: number,
  cause: unknown,
): MailClientError {
  if (status === 401) {
    return new MailClientError({
      code: "unauthorized",
      message: "Agent Mail credential is invalid or revoked",
      status,
      cause,
    });
  }
  if (status === 403) {
    return new MailClientError({
      code: "forbidden",
      message: "Agent Mail credential is not allowed to access this mailbox",
      status,
      cause,
    });
  }
  if (status === 429) {
    return new MailClientError({
      code: "rate_limited",
      message: "Agent Mail temporarily rate limited the request",
      status,
      cause,
    });
  }
  return new MailClientError({
    code: "http_error",
    message: `Agent Mail returned HTTP ${String(status)}`,
    status,
    cause,
  });
}

function outboundIdempotencyKey(intentId: string): string {
  requireNonEmpty(intentId, "outbound intent id");
  return createHash("sha256").update(intentId, "utf8").digest("hex");
}

function isOwnerReviewRequired(response: JsonResponse): boolean {
  return (
    response.status === 409 &&
    readServerErrorCode(response.body) === "outbound_review_required"
  );
}

function parsePreparedAgentDraftResponse(
  response: JsonResponse,
): MailOwnerConfirmationRequired {
  if (response.status !== 201) {
    throw new MailClientError({
      code: readServerErrorCode(response.body),
      message: readServerErrorMessage(response.body),
      status: response.status,
      outcome: response.status >= 500 ? "unknown" : "not-sent",
    });
  }
  const outcome = readRequiredString(response.body, "outcome");
  const status = readRequiredString(response.body, "status");
  const draftType = readRequiredString(response.body, "draftType");
  const draftVersion = response.body["draftVersion"];
  if (
    outcome !== "owner_confirmation_required" ||
    status !== "pending_confirmation" ||
    (draftType !== "agent_pending_confirmation" &&
      draftType !== "agent_reply_draft") ||
    !Number.isSafeInteger(draftVersion) ||
    Number(draftVersion) <= 0
  ) {
    throw invalidJsonResponse(
      "Agent Mail returned an invalid prepared Draft response",
    );
  }
  const result: MailOwnerConfirmationRequired = {
    outcome,
    status,
    draftType,
    draftId: readRequiredString(response.body, "draftId"),
    draftSubject: readRequiredString(response.body, "draftSubject"),
    draftVersion: Number(draftVersion),
  };
  const sourceEmailId = readOptionalString(response.body["sourceEmailId"]);
  if (sourceEmailId !== "") {
    result.sourceEmailId = sourceEmailId;
  }
  const senderAddress = readOptionalString(response.body["senderAddress"]);
  if (senderAddress !== "") {
    result.senderAddress = senderAddress;
  }
  const threadId = readOptionalString(response.body["threadId"]);
  if (threadId !== "") {
    result.threadId = threadId;
  }
  return result;
}

function parseOwnerReviewRequired(
  body: Record<string, unknown>,
): MailOwnerReviewRequired {
  const policy = readRecord(body, "policy");
  const outcome = readRequiredString(policy, "outcome");
  const status = readRequiredString(policy, "status");
  const source = readRequiredString(policy, "source");
  if (outcome !== "owner_review_required" || status !== "pending_confirmation") {
    throw new MailClientError({
      code: "invalid_policy_response",
      message: "Agent Mail returned an invalid outbound review outcome",
      status: 409,
    });
  }
  if (source !== "owner_direct" && source !== "inbound_auto_reply") {
    throw new MailClientError({
      code: "invalid_policy_response",
      message: "Agent Mail returned an invalid outbound review source",
      status: 409,
    });
  }
  const draftVersion = policy["draftVersion"];
  if (!Number.isSafeInteger(draftVersion) || Number(draftVersion) <= 0) {
    throw new MailClientError({
      code: "invalid_policy_response",
      message: "Agent Mail returned an invalid outbound Draft version",
      status: 409,
    });
  }
  const rawReasons = policy["reasons"];
  if (!Array.isArray(rawReasons)) {
    throw new MailClientError({
      code: "invalid_policy_response",
      message: "Agent Mail returned invalid outbound policy reasons",
      status: 409,
    });
  }
  const reasons = rawReasons.map((value) => {
    if (!isRecord(value)) {
      throw new MailClientError({
        code: "invalid_policy_response",
        message: "Agent Mail returned a malformed outbound policy reason",
        status: 409,
      });
    }
    return {
      code: readRequiredString(value, "code"),
      title: readRequiredString(value, "title"),
      description: readRequiredString(value, "description"),
    };
  });
  const result: MailOwnerReviewRequired = {
    outcome,
    status,
    draftId: readRequiredString(policy, "draftId"),
    draftSubject: readOptionalString(policy["draftSubject"]),
    draftVersion: Number(draftVersion),
    policyVersion: readRequiredString(policy, "policyVersion"),
    reasons,
    source,
  };
  const sourceEmailId = readOptionalString(policy["sourceEmailId"]);
  if (sourceEmailId !== "") {
    result.sourceEmailId = sourceEmailId;
  }
  return result;
}

function parseAcceptedWrite(body: Record<string, unknown>): MailWriteAccepted {
  const result: MailWriteAccepted = {
    outcome: "accepted",
    messageId: readRequiredString(body, "messageId"),
    submissionIds: readSubmissionIds(body, "submissionIds"),
  };
  const senderAddress = readOptionalString(body["senderAddress"]);
  if (senderAddress !== "") {
    result.senderAddress = senderAddress;
  }
  return result;
}

function parseMailMessage(
  value: Record<string, unknown>,
  emailId: string,
): MailMessage {
  const bodyStructure = isRecord(value["bodyStructure"])
    ? value["bodyStructure"]
    : undefined;
  const bodyValues = isRecord(value["bodyValues"])
    ? value["bodyValues"]
    : {};
  const textBody = firstBodyValue(bodyStructure, bodyValues, "text/plain");
  const htmlBody = firstBodyValue(bodyStructure, bodyValues, "text/html");

  const message: MailMessage = {
    emailId,
    mailboxIds: Object.entries(
      isRecord(value["mailboxIds"]) ? value["mailboxIds"] : {},
    )
      .filter(([, included]) => included === true)
      .map(([mailboxId]) => mailboxId),
    from: readAddresses(value["from"]),
    to: readAddresses(value["to"]),
    cc: readAddresses(value["cc"]),
    subject: readOptionalString(value["subject"]),
    preview: readOptionalString(value["preview"]),
    hasAttachment: value["hasAttachment"] === true,
  };
  const threadId = readOptionalString(value["threadId"]);
  if (threadId !== "") {
    message.threadId = threadId;
  }
  const receivedAt = readOptionalString(value["receivedAt"]);
  if (receivedAt !== "") {
    message.receivedAt = receivedAt;
  }
  if (textBody !== undefined) {
    message.textBody = textBody;
  }
  if (htmlBody !== undefined) {
    message.htmlBody = htmlBody;
  }
  return message;
}

function readNonNegativeInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || Number(item) < 0) {
    throw invalidJsonResponse(`Agent Mail response field ${key} must be a non-negative integer`);
  }
  return Number(item);
}

function readRequiredJsonBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const item = value[key];
  if (typeof item !== "boolean") {
    throw invalidJsonResponse(`Agent Mail response field ${key} must be a boolean`);
  }
  return item;
}

function invalidJsonResponse(message: string): MailClientError {
  return new MailClientError({ code: "invalid_json_response", message });
}

function firstBodyValue(
  structure: Record<string, unknown> | undefined,
  bodyValues: Record<string, unknown>,
  wantedType: string,
): string | undefined {
  const partIds: string[] = [];
  collectPartIds(structure, wantedType, partIds);
  for (const partId of partIds) {
    const bodyValue = bodyValues[partId];
    if (isRecord(bodyValue) && typeof bodyValue["value"] === "string") {
      return bodyValue["value"];
    }
  }
  return undefined;
}

function collectPartIds(
  part: Record<string, unknown> | undefined,
  wantedType: string,
  output: string[],
): void {
  if (part === undefined) {
    return;
  }
  if (part["type"] === wantedType && typeof part["partId"] === "string") {
    output.push(part["partId"]);
  }
  const subParts = part["subParts"];
  if (!Array.isArray(subParts)) {
    return;
  }
  for (const child of subParts) {
    if (isRecord(child)) {
      collectPartIds(child, wantedType, output);
    }
  }
}

function readAddresses(value: unknown): MailAddress[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item["email"] !== "string") {
      return [];
    }
    const address: MailAddress = { email: item["email"] };
    if (typeof item["name"] === "string") {
      address.name = item["name"];
    }
    return [address];
  });
}

function httpResponseError(response: JsonResponse): MailClientError {
  return new MailClientError({
    code: readServerErrorCode(response.body),
    message: readServerErrorMessage(response.body),
    status: response.status,
  });
}

function invalidJmapResponse(message: string): MailClientError {
  return new MailClientError({ code: "invalid_jmap_response", message });
}

function readServerErrorCode(body: Record<string, unknown>): string {
  const error = body["error"];
  return isRecord(error) && typeof error["code"] === "string"
    ? error["code"]
    : "agent_mail_error";
}

function readServerErrorMessage(body: Record<string, unknown>): string {
  const error = body["error"];
  return isRecord(error) && typeof error["message"] === "string"
    ? error["message"]
    : "Agent Mail request failed";
}

function readRecord(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const nested = value[key];
  if (!isRecord(nested)) {
    throw new MailClientError({
      code: "invalid_response",
      message: `Agent Mail response is missing ${key}`,
    });
  }
  return nested;
}

function readArray(value: Record<string, unknown>, key: string): unknown[] {
  const nested = value[key];
  if (!Array.isArray(nested)) {
    throw new MailClientError({
      code: "invalid_response",
      message: `Agent Mail response is missing ${key}`,
    });
  }
  return nested;
}

function readRequiredString(
  value: Record<string, unknown>,
  key: string,
): string {
  const nested = value[key];
  if (typeof nested !== "string" || nested.length === 0) {
    throw new MailClientError({
      code: "invalid_response",
      message: `Agent Mail response is missing ${key}`,
    });
  }
  return nested;
}

function readSubmissionIds(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const nested = value[key];
  if (
    !Array.isArray(nested) ||
    !nested.every(
      (item) =>
        typeof item === "string" ||
        (typeof item === "number" && Number.isSafeInteger(item) && item > 0),
    )
  ) {
    throw new MailClientError({
      code: "invalid_response",
      message: `Agent Mail response has invalid ${key}`,
    });
  }
  return nested.map(String);
}

function readOptionalString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readStrictStringArray(
  value: Record<string, unknown>,
  key: string,
): string[] {
  const nested = value[key];
  if (
    !Array.isArray(nested) ||
    !nested.every((item) => typeof item === "string" && item.length > 0) ||
    new Set(nested).size !== nested.length
  ) {
    throw invalidJmapResponse(`JMAP response has invalid ${key}`);
  }
  return nested;
}

function readRequiredState(
  value: Record<string, unknown>,
  key: string,
): string {
  const state = readRequiredString(value, key);
  requireState(state, key);
  return state;
}

function readRequiredBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean {
  const nested = value[key];
  if (typeof nested !== "boolean") {
    throw invalidJmapResponse(`JMAP response has invalid ${key}`);
  }
  return nested;
}

function requireState(value: string, label: string): void {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new MailClientError({
      code: "invalid_jmap_state",
      message: `${label} must be a canonical non-negative integer string`,
    });
  }
}

function requireNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new MailClientError({
      code: "invalid_argument",
      message: `${label} must not be empty`,
    });
  }
}

function requireMailboxList(
  values: readonly string[],
  label: string,
  required: boolean,
): string[] {
  if (!Array.isArray(values) || (required && values.length === 0)) {
    throw new MailClientError({
      code: "invalid_argument",
      message: `${label} must contain at least one mailbox`,
    });
  }
  if (values.length > 100) {
    throw new MailClientError({
      code: "invalid_argument",
      message: `${label} contains too many mailboxes`,
    });
  }
  const normalized = values.map((value) => {
    const mailbox = requireBoundedString(value, `${label} mailbox`, 320, false);
    if (
      mailbox.split("@").length !== 2 ||
      /[\u0000-\u001f\u007f\s]/.test(mailbox)
    ) {
      throw new MailClientError({
        code: "invalid_argument",
        message: `${label} contains an invalid mailbox`,
      });
    }
    return mailbox;
  });
  if (new Set(normalized.map((value) => value.toLowerCase())).size !== normalized.length) {
    throw new MailClientError({
      code: "invalid_argument",
      message: `${label} contains duplicate mailboxes`,
    });
  }
  return normalized;
}

function requireBoundedString(
  value: string,
  label: string,
  maxLength: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string") {
    throw new MailClientError({
      code: "invalid_argument",
      message: `${label} must be a string`,
    });
  }
  const normalized = value.trim();
  if ((!allowEmpty && normalized.length === 0) || normalized.length > maxLength) {
    throw new MailClientError({
      code: "invalid_argument",
      message: `${label} is invalid`,
    });
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
