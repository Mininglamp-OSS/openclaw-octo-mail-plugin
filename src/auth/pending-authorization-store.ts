import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  readSecretFileSync,
  writePrivateSecretFileAtomic,
} from "openclaw/plugin-sdk/secret-file-runtime";

const STORE_VERSION = 1;
const AUTH_DIRECTORY = join("plugins", "octo-mail", "auth-pending");

export interface PendingAgentAuthorization {
  version: 1;
  pluginAccountId: string;
  botId: string;
  botProfile?: string;
  deviceCode: string;
  codeVerifier: string;
  userCode: string;
  verificationUriComplete: string;
  requestedMailboxAddress?: string;
  spaceId?: string;
  createdAt: string;
  expiresAt: string;
  intervalSeconds: number;
}

export interface PendingAuthorizationStore {
  save(record: PendingAgentAuthorization): Promise<void>;
  load(pluginAccountId: string): Promise<PendingAgentAuthorization | undefined>;
  delete(pluginAccountId: string): Promise<void>;
}

export class PrivatePendingAuthorizationStore
  implements PendingAuthorizationStore
{
  readonly #rootDir: string;

  constructor(stateDir: string) {
    this.#rootDir = resolve(stateDir, AUTH_DIRECTORY);
  }

  async save(record: PendingAgentAuthorization): Promise<void> {
    const validated = validatePendingAuthorization(record);
    await writePrivateSecretFileAtomic({
      rootDir: this.#rootDir,
      filePath: this.#path(validated.pluginAccountId),
      content: JSON.stringify(validated),
    });
  }

  async load(
    pluginAccountId: string,
  ): Promise<PendingAgentAuthorization | undefined> {
    const path = this.#path(pluginAccountId);
    let raw: string;
    try {
      raw = readSecretFileSync(path, "Agent Mail pending authorization");
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new Error("Agent Mail pending authorization file is invalid JSON", {
        cause,
      });
    }
    const record = validatePendingAuthorization(parsed);
    if (record.pluginAccountId !== normalizeAccountId(pluginAccountId)) {
      throw new Error(
        "Agent Mail pending authorization belongs to another Plugin Account",
      );
    }
    return record;
  }

  async delete(pluginAccountId: string): Promise<void> {
    await rm(this.#path(pluginAccountId), { force: true });
  }

  #path(pluginAccountId: string): string {
    return join(
      this.#rootDir,
      `${createHash("sha256").update(normalizeAccountId(pluginAccountId)).digest("hex")}.json`,
    );
  }
}

export function createPendingAuthorization(
  input: Omit<PendingAgentAuthorization, "version">,
): PendingAgentAuthorization {
  return validatePendingAuthorization({ version: STORE_VERSION, ...input });
}

function validatePendingAuthorization(
  value: unknown,
): PendingAgentAuthorization {
  if (!isRecord(value)) {
    throw new Error("Agent Mail pending authorization must be an object");
  }
  const allowed = new Set([
    "version",
    "pluginAccountId",
    "botId",
    "botProfile",
    "deviceCode",
    "codeVerifier",
    "userCode",
    "verificationUriComplete",
    "requestedMailboxAddress",
    "spaceId",
    "createdAt",
    "expiresAt",
    "intervalSeconds",
  ]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Agent Mail pending authorization contains unknown keys: ${unknown.join(", ")}`,
    );
  }
  if (value["version"] !== STORE_VERSION) {
    throw new Error("Agent Mail pending authorization version is unsupported");
  }
  const pluginAccountId = normalizeAccountId(value["pluginAccountId"]);
  const botId = boundedString(value["botId"], "botId", 256);
  const botProfile = optionalBoundedString(value["botProfile"], "botProfile", 128);
  const deviceCode = boundedString(value["deviceCode"], "deviceCode", 4_096);
  const codeVerifier = boundedString(value["codeVerifier"], "codeVerifier", 256);
  const userCode = boundedString(value["userCode"], "userCode", 128);
  const verificationUriComplete = httpUrl(
    value["verificationUriComplete"],
    "verificationUriComplete",
  );
  const requestedMailboxAddress = optionalBoundedString(
    value["requestedMailboxAddress"],
    "requestedMailboxAddress",
    320,
  );
  const spaceId = optionalBoundedString(value["spaceId"], "spaceId", 200);
  const createdAt = isoDate(value["createdAt"], "createdAt");
  const expiresAt = isoDate(value["expiresAt"], "expiresAt");
  const intervalSeconds = value["intervalSeconds"];
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isInteger(intervalSeconds) ||
    intervalSeconds <= 0 ||
    intervalSeconds > 300
  ) {
    throw new Error("Agent Mail intervalSeconds is invalid");
  }
  return {
    version: STORE_VERSION,
    pluginAccountId,
    botId,
    ...(botProfile === undefined ? {} : { botProfile }),
    deviceCode,
    codeVerifier,
    userCode,
    verificationUriComplete,
    ...(requestedMailboxAddress === undefined
      ? {}
      : { requestedMailboxAddress }),
    ...(spaceId === undefined ? {} : { spaceId }),
    createdAt,
    expiresAt,
    intervalSeconds,
  };
}

function normalizeAccountId(value: unknown): string {
  const accountId = boundedString(value, "pluginAccountId", 64);
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(accountId)) {
    throw new Error("Agent Mail pending pluginAccountId is invalid");
  }
  return accountId;
}

function boundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  if (typeof value !== "string") {
    throw new Error(`Agent Mail pending ${label} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`Agent Mail pending ${label} is invalid`);
  }
  return normalized;
}

function optionalBoundedString(
  value: unknown,
  label: string,
  maxLength: number,
): string | undefined {
  return value === undefined ? undefined : boundedString(value, label, maxLength);
}

function isoDate(value: unknown, label: string): string {
  const raw = boundedString(value, label, 64);
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== raw) {
    throw new Error(`Agent Mail pending ${label} is invalid`);
  }
  return raw;
}

function httpUrl(value: unknown, label: string): string {
  const raw = boundedString(value, label, 2_048);
  let url: URL;
  try {
    url = new URL(raw);
  } catch (cause) {
    throw new Error(`Agent Mail pending ${label} is invalid`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Agent Mail pending ${label} is invalid`);
  }
  return url.toString();
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  if ("code" in error && (error.code === "ENOENT" || error.code === "not-found")) {
    return true;
  }
  return "cause" in error && isNotFound(error.cause);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
