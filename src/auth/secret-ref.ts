import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  resolveSecretRefValues,
  type SecretRef,
} from "openclaw/plugin-sdk/secret-ref-runtime";

const SECRET_REF_KEYS = new Set(["source", "provider", "id"]);

export interface ResolveAgentMailCredentialOptions {
  ref: SecretRef;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}

/**
 * Parse only the canonical OpenClaw SecretRef object shape.
 *
 * Literal strings and compatibility shorthands are intentionally rejected so
 * an omb_ credential cannot be stored directly in ordinary plugin config.
 */
export function parseAgentMailCredentialRef(value: unknown): SecretRef {
  if (!isRecord(value)) {
    throw new Error(
      "octo-mail credentialRef must be a structured OpenClaw SecretRef",
    );
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => !SECRET_REF_KEYS.has(key),
  );
  if (unknownKeys.length > 0) {
    throw new Error(
      `octo-mail credentialRef contains unknown keys: ${unknownKeys.join(", ")}`,
    );
  }

  const source = value["source"];
  if (source !== "env" && source !== "file" && source !== "exec") {
    throw new Error(
      "octo-mail credentialRef source must be env, file, or exec",
    );
  }
  const provider = requireNonEmptyString(
    value["provider"],
    "octo-mail credentialRef provider",
  );
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(provider)) {
    throw new Error(
      "octo-mail credentialRef provider must match /^[a-z][a-z0-9_-]{0,63}$/",
    );
  }
  const id = requireNonEmptyString(
    value["id"],
    "octo-mail credentialRef id",
  );

  return { source, provider, id };
}

/** Resolve an Agent Mail credential without logging or persisting its value. */
export async function resolveAgentMailCredential(
  options: ResolveAgentMailCredentialOptions,
): Promise<string> {
  const ref = parseAgentMailCredentialRef(options.ref);
  const resolved = await resolveSecretRefValues(
    [ref],
    options.env === undefined
      ? { config: options.config }
      : { config: options.config, env: options.env },
  );
  const value = resolved.get(secretRefKey(ref));
  return normalizeAgentMailCredential(value);
}

/** Validate a credential at a secret boundary without including it in errors. */
export function normalizeAgentMailCredential(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      "octo-mail credentialRef resolved to an empty or non-string value",
    );
  }

  const credential = value.trim();
  if (!credential.startsWith("omb_") || credential.length === 4) {
    throw new Error(
      "octo-mail credentialRef did not resolve to an Agent Mail omb_ credential",
    );
  }
  return credential;
}

function secretRefKey(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
