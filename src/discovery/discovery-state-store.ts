import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 128 * 1024;
export const MAX_PROCESSED_EMAIL_IDS = 200;

export interface DiscoveryState {
  version: 1;
  mailAccountId: string;
  sinceState: string;
  processedEmailIds: string[];
}

export interface DiscoveryStateStore {
  load(): Promise<DiscoveryState | undefined>;
  save(state: DiscoveryState): Promise<void>;
}

export class FileDiscoveryStateStore implements DiscoveryStateStore {
  readonly #path: string;

  constructor(path: string) {
    if (path.trim().length === 0) {
      throw new Error("discovery state path must not be empty");
    }
    this.#path = path;
  }

  async load(): Promise<DiscoveryState | undefined> {
    let data: Buffer;
    try {
      data = await readFile(this.#path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    if (data.byteLength > MAX_STATE_BYTES) {
      throw new Error("discovery state exceeds the 128 KiB limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch (cause) {
      throw new Error("discovery state is not valid JSON", { cause });
    }
    return validateDiscoveryState(parsed);
  }

  async save(state: DiscoveryState): Promise<void> {
    const validated = validateDiscoveryState(state);
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${basename(this.#path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const data = `${JSON.stringify(validated, null, 2)}\n`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(data, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

export function createInitialDiscoveryState(
  mailAccountId: string,
  sinceState: string,
): DiscoveryState {
  return validateDiscoveryState({
    version: STATE_VERSION,
    mailAccountId,
    sinceState,
    processedEmailIds: [],
  });
}

export function appendProcessedEmailId(
  state: DiscoveryState,
  emailId: string,
): DiscoveryState {
  if (emailId.length === 0 || emailId.length > 256) {
    throw new Error("processed emailId must contain 1 to 256 characters");
  }
  const withoutExisting = state.processedEmailIds.filter(
    (item) => item !== emailId,
  );
  return {
    ...state,
    processedEmailIds: [...withoutExisting, emailId].slice(
      -MAX_PROCESSED_EMAIL_IDS,
    ),
  };
}

export function validateDiscoveryState(value: unknown): DiscoveryState {
  if (!isRecord(value)) {
    throw new Error("discovery state must be an object");
  }
  const allowedKeys = new Set([
    "version",
    "mailAccountId",
    "sinceState",
    "processedEmailIds",
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `discovery state contains unknown keys: ${unknownKeys.join(", ")}`,
    );
  }
  if (value["version"] !== STATE_VERSION) {
    throw new Error("discovery state version is unsupported");
  }
  const mailAccountId = value["mailAccountId"];
  if (typeof mailAccountId !== "string" || mailAccountId.length === 0) {
    throw new Error("discovery state mailAccountId is invalid");
  }
  const sinceState = value["sinceState"];
  if (
    typeof sinceState !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(sinceState)
  ) {
    throw new Error("discovery state sinceState is invalid");
  }
  const processedEmailIds = value["processedEmailIds"];
  if (
    !Array.isArray(processedEmailIds) ||
    processedEmailIds.length > MAX_PROCESSED_EMAIL_IDS ||
    !processedEmailIds.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 256,
    ) ||
    new Set(processedEmailIds).size !== processedEmailIds.length
  ) {
    throw new Error("discovery state processedEmailIds is invalid");
  }
  return {
    version: STATE_VERSION,
    mailAccountId,
    sinceState,
    processedEmailIds: [...processedEmailIds],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
