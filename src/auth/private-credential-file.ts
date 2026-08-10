import { createHash } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  readSecretFileSync,
  writePrivateSecretFileAtomic,
} from "openclaw/plugin-sdk/secret-file-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";

import { normalizeAgentMailCredential } from "./secret-ref.js";

const CREDENTIAL_DIRECTORY = join("plugins", "octo-mail", "secrets");

export interface PrivateCredentialFileTarget {
  rootDir: string;
  filePath: string;
}

export interface ResolvePrivateCredentialFileTargetOptions {
  stateDir: string;
  pluginAccountId: string;
  ref: SecretRef;
  config: OpenClawConfig;
}

export interface ResolvePluginAccountCredentialTargetOptions {
  stateDir: string;
  pluginAccountId: string;
  credentialRef?: SecretRef | undefined;
  config: OpenClawConfig;
}

/** Resolve explicit SecretRef storage or the standard plugin-owned Bot store. */
export function resolvePluginAccountCredentialTarget(
  options: ResolvePluginAccountCredentialTargetOptions,
): PrivateCredentialFileTarget {
  if (options.credentialRef !== undefined) {
    return resolvePrivateCredentialFileTarget({
      stateDir: options.stateDir,
      pluginAccountId: options.pluginAccountId,
      ref: options.credentialRef,
      config: options.config,
    });
  }
  return {
    rootDir: resolve(options.stateDir, CREDENTIAL_DIRECTORY),
    filePath: getPrivateCredentialFilePath(
      options.stateDir,
      options.pluginAccountId,
    ),
  };
}

/**
 * Resolve the only file path this plugin may write for one Plugin Account.
 *
 * The global SecretRef provider must already point to this exact private path;
 * the plugin never edits host secret-provider configuration itself.
 */
export function resolvePrivateCredentialFileTarget(
  options: ResolvePrivateCredentialFileTargetOptions,
): PrivateCredentialFileTarget {
  const pluginAccountId = options.pluginAccountId.trim();
  if (pluginAccountId.length === 0 || pluginAccountId.length > 128) {
    throw new Error(
      "octo-mail pluginAccountId must contain 1 to 128 characters",
    );
  }
  if (options.ref.source !== "file" || options.ref.id !== "value") {
    throw new Error(
      "octo-mail managed credential requires a singleValue file SecretRef",
    );
  }

  const provider = options.config.secrets?.providers?.[options.ref.provider];
  if (
    provider === undefined ||
    provider.source !== "file" ||
    provider.mode !== "singleValue"
  ) {
    throw new Error(
      "octo-mail managed credential provider must be configured as file/singleValue",
    );
  }
  if (provider.allowInsecurePath === true) {
    throw new Error(
      "octo-mail managed credential provider must enforce secure path checks",
    );
  }
  if (!isAbsolute(provider.path)) {
    throw new Error(
      "octo-mail managed credential provider path must be absolute",
    );
  }

  const rootDir = resolve(options.stateDir, CREDENTIAL_DIRECTORY);
  const filePath = join(rootDir, `${accountFileKey(pluginAccountId)}.credential`);
  if (resolve(provider.path) !== filePath) {
    throw new Error(
      "octo-mail managed credential provider path does not match its Plugin Account",
    );
  }
  return { rootDir, filePath };
}

export function getPrivateCredentialFilePath(
  stateDir: string,
  pluginAccountId: string,
): string {
  const normalizedId = pluginAccountId.trim();
  if (normalizedId.length === 0 || normalizedId.length > 128) {
    throw new Error(
      "octo-mail pluginAccountId must contain 1 to 128 characters",
    );
  }
  return join(
    resolve(stateDir, CREDENTIAL_DIRECTORY),
    `${accountFileKey(normalizedId)}.credential`,
  );
}

/** Atomically create or rotate one plugin-owned credential file. */
export async function writePrivateAgentMailCredential(
  target: PrivateCredentialFileTarget,
  credentialValue: unknown,
): Promise<void> {
  const credential = normalizeAgentMailCredential(credentialValue);
  await writePrivateSecretFileAtomic({
    rootDir: target.rootDir,
    filePath: target.filePath,
    content: credential,
  });
}

/** Read one plugin-owned credential without ever exposing it in CLI output. */
export function readPrivateAgentMailCredential(
  target: PrivateCredentialFileTarget,
): string {
  return normalizeAgentMailCredential(
    readSecretFileSync(target.filePath, "OCTO Agent Mail credential", {
      rejectSymlink: true,
      rejectHardlinks: true,
    }),
  );
}

function accountFileKey(pluginAccountId: string): string {
  return createHash("sha256").update(pluginAccountId).digest("hex");
}
