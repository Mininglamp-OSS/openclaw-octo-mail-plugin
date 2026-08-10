import { normalizeAgentMailCredential } from "./secret-ref.js";
import { normalizeOctoOrigin } from "../mail/octo-origin.js";

const DEVICE_PATH = "/agent-mail-api/webapi/v0/agent-auth/device";
const TOKEN_PATH = "/agent-mail-api/webapi/v0/agent-auth/token";
const MAX_RESPONSE_CHARS = 256 * 1024;

type FetchLike = typeof fetch;

export interface AgentMailAuthorizationClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export interface CreateDeviceAuthorizationInput {
  botId: string;
  botProfile?: string;
  mailboxAddress?: string;
  spaceId: string;
  codeChallenge: string;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface ExchangeAuthorizationInput {
  deviceCode: string;
  codeVerifier: string;
}

export interface AgentMailboxCredential {
  accessToken: string;
  mailboxAddress: string;
  botId: string;
  botProfile?: string;
}

export class AgentMailAuthorizationError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(options: {
    code: string;
    message: string;
    status?: number;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = "AgentMailAuthorizationError";
    this.code = options.code;
    this.status = options.status;
  }
}

export class AgentMailAuthorizationClient {
  readonly #origin: string;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  constructor(options: AgentMailAuthorizationClientOptions) {
    this.#origin = normalizeOctoOrigin(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error(
        "Agent Mail authorization timeoutMs must be a positive integer",
      );
    }
  }

  async createDeviceAuthorization(
    input: CreateDeviceAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<DeviceAuthorization> {
    const botId = requireString(input.botId, "botId", 256);
    const botProfile = optionalString(input.botProfile, "botProfile", 128);
    const mailboxAddress = optionalMailbox(input.mailboxAddress);
    const spaceId = requireString(input.spaceId, "spaceId", 200);
    const codeChallenge = requireBase64UrlSha256(input.codeChallenge);
    const body = await this.#postJson(
      DEVICE_PATH,
      {
        botId,
        clientName: "openclaw-octo-mail-plugin",
        spaceId,
        codeChallenge,
        ...(botProfile === undefined ? {} : { botProfile }),
        ...(mailboxAddress === undefined ? {} : { mailboxAddress }),
      },
      signal,
    );
    return {
      deviceCode: readString(body, "deviceCode", 4_096),
      userCode: readString(body, "userCode", 128),
      verificationUri: readUrl(body, "verificationUri", this.#origin),
      verificationUriComplete: readUrl(
        body,
        "verificationUriComplete",
        this.#origin,
      ),
      expiresIn: readPositiveInteger(body, "expiresIn", 86_400),
      interval: readPositiveInteger(body, "interval", 300),
    };
  }

  async exchangeAuthorization(
    input: ExchangeAuthorizationInput,
    signal?: AbortSignal,
  ): Promise<AgentMailboxCredential> {
    const body = await this.#postJson(
      TOKEN_PATH,
      {
        deviceCode: requireString(input.deviceCode, "deviceCode", 4_096),
        codeVerifier: requireString(input.codeVerifier, "codeVerifier", 256),
      },
      signal,
    );
    const rawToken = body["accessToken"];
    const accessToken = normalizeAgentMailCredential(rawToken);
    const botProfile = optionalResponseString(body["botProfile"], 128);
    return {
      accessToken,
      mailboxAddress: readMailbox(body, "mailboxAddress"),
      botId: readString(body, "botId", 256),
      ...(botProfile === undefined ? {} : { botProfile }),
    };
  }

  async #postJson(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted === true) {
      throw new AgentMailAuthorizationError({
        code: "request_aborted",
        message: "Agent Mail authorization request was aborted before it started",
      });
    }
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error("Agent Mail authorization timed out")),
      this.#timeoutMs,
    );

    let response: Response;
    let raw: string;
    try {
      response = await this.#fetch(`${this.#origin}${path}`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      raw = await response.text();
    } catch (cause) {
      throw new AgentMailAuthorizationError({
        code: controller.signal.aborted ? "request_aborted" : "transport_failure",
        message: "Agent Mail authorization request failed",
        cause,
      });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromCaller);
    }
    if (raw.length > MAX_RESPONSE_CHARS) {
      throw new AgentMailAuthorizationError({
        code: "response_too_large",
        message: "Agent Mail authorization response is too large",
        status: response.status,
      });
    }
    let parsed: unknown;
    try {
      parsed = raw.length === 0 ? {} : JSON.parse(raw);
    } catch (cause) {
      throw new AgentMailAuthorizationError({
        code: "invalid_json_response",
        message: "Agent Mail authorization returned invalid JSON",
        status: response.status,
        cause,
      });
    }
    if (!isRecord(parsed)) {
      throw new AgentMailAuthorizationError({
        code: "invalid_json_response",
        message: "Agent Mail authorization returned a non-object response",
        status: response.status,
      });
    }
    if (!response.ok) {
      const error = isRecord(parsed["error"]) ? parsed["error"] : {};
      throw new AgentMailAuthorizationError({
        code:
          typeof error["code"] === "string"
            ? error["code"]
            : "agent_mail_authorization_error",
        message:
          typeof error["message"] === "string"
            ? error["message"]
            : "Agent Mail authorization request failed",
        status: response.status,
      });
    }
    return parsed;
  }
}

function requireString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${label} must contain 1 to ${maxLength} characters`);
  }
  return normalized;
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : requireString(value, label, maxLength);
}

function optionalMailbox(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return validateMailbox(requireString(value, "mailboxAddress", 320));
}

function readMailbox(value: Record<string, unknown>, key: string): string {
  return validateMailbox(readString(value, key, 320));
}

function validateMailbox(value: string): string {
  if (value.split("@").length !== 2) {
    throw new Error("mailboxAddress must contain exactly one @ character");
  }
  return value;
}

function requireBase64UrlSha256(value: unknown): string {
  const normalized = requireString(value, "codeChallenge", 64);
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) {
    throw new Error("codeChallenge must be a base64url SHA-256 digest");
  }
  return normalized;
}

function readString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string {
  try {
    return requireString(value[key], key, maxLength);
  } catch (cause) {
    throw new AgentMailAuthorizationError({
      code: "invalid_response",
      message: `Agent Mail authorization response has invalid ${key}`,
      cause,
    });
  }
}

function optionalResponseString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  return requireString(value, "botProfile", maxLength);
}

function readPositiveInteger(
  value: Record<string, unknown>,
  key: string,
  maximum: number,
): number {
  const item = value[key];
  if (!Number.isInteger(item) || typeof item !== "number" || item <= 0 || item > maximum) {
    throw new AgentMailAuthorizationError({
      code: "invalid_response",
      message: `Agent Mail authorization response has invalid ${key}`,
    });
  }
  return item;
}

function readUrl(
  value: Record<string, unknown>,
  key: string,
  baseUrl: string,
): string {
  const raw = readString(value, key, 2_048);
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch (cause) {
    throw new AgentMailAuthorizationError({
      code: "invalid_response",
      message: `Agent Mail authorization response has invalid ${key}`,
      cause,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AgentMailAuthorizationError({
      code: "invalid_response",
      message: `Agent Mail authorization response has invalid ${key}`,
    });
  }
  return url.toString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
