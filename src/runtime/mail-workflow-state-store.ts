import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const STATE_VERSION = 1;
const MAX_STATE_BYTES = 256 * 1024;
const MAX_NOTIFICATION_IDS = 1_000;

export interface PendingMailConfirmation {
  sessionKey: string;
  agentId: string;
  pluginAccountId: string;
  draftId: string;
  draftVersion: number;
  createdAt: string;
}

interface MailWorkflowState {
  version: 1;
  pendingBySession: Record<string, PendingMailConfirmation>;
  deliveredNotificationIds: string[];
}

export interface MailWorkflowStateStore {
  savePending(value: PendingMailConfirmation): Promise<void>;
  getPending(sessionKey: string): Promise<PendingMailConfirmation | undefined>;
  clearPending(sessionKey: string): Promise<PendingMailConfirmation | undefined>;
  notificationDelivered(notificationId: string): Promise<boolean>;
  markNotificationDelivered(notificationId: string): Promise<void>;
}

export class FileMailWorkflowStateStore implements MailWorkflowStateStore {
  readonly #path: string;
  #operation = Promise.resolve();

  constructor(path: string) {
    if (path.trim().length === 0) {
      throw new Error("mail workflow state path must not be empty");
    }
    this.#path = path;
  }

  async savePending(value: PendingMailConfirmation): Promise<void> {
    validatePending(value);
    await this.#mutate((state) => {
      state.pendingBySession[value.sessionKey] = { ...value };
    });
  }

  async getPending(
    sessionKey: string,
  ): Promise<PendingMailConfirmation | undefined> {
    requireKey(sessionKey, "sessionKey");
    await this.#operation;
    const value = (await this.#load()).pendingBySession[sessionKey];
    return value === undefined ? undefined : { ...value };
  }

  async clearPending(
    sessionKey: string,
  ): Promise<PendingMailConfirmation | undefined> {
    requireKey(sessionKey, "sessionKey");
    let removed: PendingMailConfirmation | undefined;
    await this.#mutate((state) => {
      const value = state.pendingBySession[sessionKey];
      if (value !== undefined) {
        removed = { ...value };
        delete state.pendingBySession[sessionKey];
      }
    });
    return removed;
  }

  async notificationDelivered(notificationId: string): Promise<boolean> {
    requireKey(notificationId, "notificationId");
    await this.#operation;
    return (await this.#load()).deliveredNotificationIds.includes(notificationId);
  }

  async markNotificationDelivered(notificationId: string): Promise<void> {
    requireKey(notificationId, "notificationId");
    await this.#mutate((state) => {
      state.deliveredNotificationIds = [
        ...state.deliveredNotificationIds.filter((id) => id !== notificationId),
        notificationId,
      ].slice(-MAX_NOTIFICATION_IDS);
    });
  }

  async #mutate(update: (state: MailWorkflowState) => void): Promise<void> {
    const operation = this.#operation.then(async () => {
      const state = await this.#load();
      update(state);
      await this.#save(state);
    });
    this.#operation = operation.catch(() => undefined);
    await operation;
  }

  async #load(): Promise<MailWorkflowState> {
    let data: Buffer;
    try {
      data = await readFile(this.#path);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return emptyState();
      }
      throw error;
    }
    if (data.byteLength > MAX_STATE_BYTES) {
      throw new Error("mail workflow state exceeds the 256 KiB limit");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch (cause) {
      throw new Error("mail workflow state is not valid JSON", { cause });
    }
    return validateState(parsed);
  }

  async #save(state: MailWorkflowState): Promise<void> {
    const validated = validateState(state);
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = join(
      directory,
      `.${basename(this.#path)}.${process.pid}.${randomUUID()}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        temporaryPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, "utf8");
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

function emptyState(): MailWorkflowState {
  return {
    version: STATE_VERSION,
    pendingBySession: {},
    deliveredNotificationIds: [],
  };
}

function validateState(value: unknown): MailWorkflowState {
  if (!isRecord(value) || value["version"] !== STATE_VERSION) {
    throw new Error("mail workflow state version is unsupported");
  }
  const rawPending = value["pendingBySession"];
  const rawNotifications = value["deliveredNotificationIds"];
  if (!isRecord(rawPending)) {
    throw new Error("mail workflow pending confirmations are invalid");
  }
  const pendingBySession: Record<string, PendingMailConfirmation> = {};
  for (const [sessionKey, pending] of Object.entries(rawPending)) {
    if (!isRecord(pending)) {
      throw new Error("mail workflow pending confirmation is invalid");
    }
    const normalized = {
      sessionKey: readString(pending, "sessionKey"),
      agentId: readString(pending, "agentId"),
      pluginAccountId: readString(pending, "pluginAccountId"),
      draftId: readString(pending, "draftId"),
      draftVersion: readPositiveInteger(pending, "draftVersion"),
      createdAt: readString(pending, "createdAt"),
    };
    validatePending(normalized);
    if (normalized.sessionKey !== sessionKey) {
      throw new Error("mail workflow session key does not match its record");
    }
    pendingBySession[sessionKey] = normalized;
  }
  if (
    !Array.isArray(rawNotifications) ||
    rawNotifications.length > MAX_NOTIFICATION_IDS ||
    !rawNotifications.every(
      (item) => typeof item === "string" && item.length > 0 && item.length <= 256,
    ) ||
    new Set(rawNotifications).size !== rawNotifications.length
  ) {
    throw new Error("mail workflow notification ids are invalid");
  }
  return {
    version: STATE_VERSION,
    pendingBySession,
    deliveredNotificationIds: [...rawNotifications],
  };
}

function validatePending(value: PendingMailConfirmation): void {
  requireKey(value.sessionKey, "sessionKey");
  requireKey(value.agentId, "agentId");
  requireKey(value.pluginAccountId, "pluginAccountId");
  requireKey(value.draftId, "draftId");
  if (!Number.isSafeInteger(value.draftVersion) || value.draftVersion <= 0) {
    throw new Error("draftVersion must be a positive integer");
  }
  if (!Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error("createdAt must be an ISO date-time");
  }
}

function requireKey(value: string, name: string): void {
  if (value.trim().length === 0 || value.length > 512) {
    throw new Error(`${name} must contain 1 to 512 characters`);
  }
}

function readString(value: Record<string, unknown>, key: string): string {
  const item = value[key];
  if (typeof item !== "string") {
    throw new Error(`mail workflow ${key} is invalid`);
  }
  return item;
}

function readPositiveInteger(
  value: Record<string, unknown>,
  key: string,
): number {
  const item = value[key];
  if (!Number.isSafeInteger(item) || Number(item) <= 0) {
    throw new Error(`mail workflow ${key} is invalid`);
  }
  return Number(item);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
