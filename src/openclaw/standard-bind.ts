import { stat } from "node:fs/promises";

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";

import { resolveRuntimePluginAccounts } from "../accounts/plugin-account-source.js";
import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import {
  readPrivateAgentMailCredential,
  resolvePluginAccountCredentialTarget,
} from "../auth/private-credential-file.js";
import {
  AgentMailAuthorizationService,
  type AuthorizationRequiredResult,
  type AuthorizationStatusResult,
} from "../auth/agent-mail-authorization-service.js";
import type { PluginConfig } from "../config/plugin-config.js";
import { AgentMailApiClient } from "../mail/agent-mail-api-client.js";
import { normalizeOctoOrigin } from "../mail/octo-origin.js";

export interface StandardBindOptions {
  config: OpenClawConfig;
  pluginConfig: PluginConfig;
  stateDir: string;
  agentId: string;
  mailboxAddress: string;
  spaceId: string;
  apiUrl?: string;
  wait: boolean;
  onAuthorizationRequired?: (result: AuthorizationRequiredResult) => void;
}

export type StandardBindResult =
  | {
      status: "authorization_required";
      pluginAccountId: string;
      mailboxAddress: string;
      verificationUri: string;
      expiresAt: string;
    }
  | {
      status: "connected";
      pluginAccountId: string;
      mailboxAddress: string;
      alreadyConnected: boolean;
    };

interface StandardBindDependencies {
  credentialExists?: (
    account: PluginAccountConfig,
    options: Pick<StandardBindOptions, "config" | "stateDir">,
  ) => Promise<boolean>;
  readCredential?: (
    account: PluginAccountConfig,
    options: Pick<StandardBindOptions, "config" | "stateDir">,
  ) => string;
  getIdentityAddress?: (
    account: PluginAccountConfig,
    credential: string,
  ) => Promise<string>;
  createAuthorizationService?: (
    options: Pick<StandardBindOptions, "config" | "stateDir">,
  ) => AuthorizationServiceLike;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface AuthorizationServiceLike {
  start(
    account: PluginAccountConfig,
    mailboxAddress: string,
    spaceId: string,
  ): Promise<AuthorizationRequiredResult>;
  check(account: PluginAccountConfig): Promise<AuthorizationStatusResult>;
  stop(): Promise<void>;
}

/**
 * Start or complete one owner-approved mailbox binding.
 *
 * Bot identity and OCTO origin are always resolved from trusted OpenClaw
 * configuration. User input can only select an Agent and assert an origin.
 */
export async function bindStandardMailbox(
  options: StandardBindOptions,
  dependencies: StandardBindDependencies = {},
): Promise<StandardBindResult> {
  const agentId = requireBoundedValue(options.agentId, "agent", 128);
  const mailboxAddress = normalizeMailboxAddress(options.mailboxAddress);
  const spaceId = requireBoundedValue(options.spaceId, "space-id", 200);
  const account = selectTrustedAccount(
    options.config,
    options.pluginConfig,
    agentId,
  );
  assertApiOrigin(options.apiUrl, account.apiBaseUrl);

  const credentialExists =
    dependencies.credentialExists ?? defaultCredentialExists;
  if (
    await credentialExists(account, {
      config: options.config,
      stateDir: options.stateDir,
    })
  ) {
    const credential = (
      dependencies.readCredential ?? defaultReadCredential
    )(account, { config: options.config, stateDir: options.stateDir });
    let connectedAddress: string;
    try {
      connectedAddress = await (
        dependencies.getIdentityAddress ?? defaultGetIdentityAddress
      )(account, credential);
    } catch (cause) {
      throw new Error(
        `Agent ${agentId} already has a stored mailbox credential that could not be verified; remove or revoke it explicitly before binding again`,
        { cause },
      );
    }
    if (!sameMailboxAddress(connectedAddress, mailboxAddress)) {
      throw new Error(
        `Agent ${agentId} is already connected to ${connectedAddress}; refusing to replace it with ${mailboxAddress}`,
      );
    }
    return {
      status: "connected",
      pluginAccountId: account.pluginAccountId,
      mailboxAddress: connectedAddress,
      alreadyConnected: true,
    };
  }

  const service = (
    dependencies.createAuthorizationService ?? defaultCreateService
  )({ config: options.config, stateDir: options.stateDir });
  try {
    const authorization = await service.start(account, mailboxAddress, spaceId);
    options.onAuthorizationRequired?.(authorization);
    if (!options.wait) {
      return {
        status: "authorization_required",
        pluginAccountId: account.pluginAccountId,
        mailboxAddress,
        verificationUri: authorization.verificationUri,
        expiresAt: authorization.expiresAt,
      };
    }
    return await waitForTerminalAuthorization({
      service,
      account,
      mailboxAddress,
      authorization,
      sleep: dependencies.sleep ?? defaultSleep,
    });
  } finally {
    await service.stop();
  }
}

function selectTrustedAccount(
  config: OpenClawConfig,
  pluginConfig: PluginConfig,
  agentId: string,
): PluginAccountConfig {
  const discovery = resolveRuntimePluginAccounts(config, pluginConfig);
  const accounts = discovery.accounts.filter(
    (account) => account.enabled && account.agentId === agentId,
  );
  if (accounts.length === 1) {
    return accounts[0]!;
  }
  if (accounts.length > 1) {
    throw new Error(
      `Agent ${agentId} has multiple mailbox accounts; refusing ambiguous binding`,
    );
  }
  const issues = discovery.issues
    .filter((issue) => issue.agentId === agentId)
    .map((issue) => issue.message);
  throw new Error(
    issues.length === 0
      ? `Agent ${agentId} has no trusted OCTO Bot binding`
      : `Agent ${agentId} has no usable OCTO Bot binding: ${issues.join("; ")}`,
  );
}

function assertApiOrigin(
  assertedApiUrl: string | undefined,
  trustedApiUrl: string,
): void {
  if (assertedApiUrl === undefined) {
    return;
  }
  const asserted = normalizeOctoOrigin(assertedApiUrl.trim());
  const trusted = normalizeOctoOrigin(trustedApiUrl);
  if (asserted !== trusted) {
    throw new Error(
      `--api-url ${asserted} does not match the trusted OCTO binding ${trusted}`,
    );
  }
}

async function waitForTerminalAuthorization(input: {
  service: AuthorizationServiceLike;
  account: PluginAccountConfig;
  mailboxAddress: string;
  authorization: AuthorizationRequiredResult;
  sleep: (milliseconds: number) => Promise<void>;
}): Promise<StandardBindResult> {
  let intervalSeconds = input.authorization.pollIntervalSeconds;
  while (true) {
    await input.sleep(intervalSeconds * 1_000);
    const result = await input.service.check(input.account);
    if (result.status === "pending") {
      intervalSeconds = result.pollIntervalSeconds;
      continue;
    }
    if (result.status === "connected") {
      if (!sameMailboxAddress(result.mailboxAddress, input.mailboxAddress)) {
        throw new Error(
          `Authorization connected unexpected mailbox ${result.mailboxAddress}`,
        );
      }
      return {
        status: "connected",
        pluginAccountId: result.pluginAccountId,
        mailboxAddress: result.mailboxAddress,
        alreadyConnected: false,
      };
    }
    throw terminalAuthorizationError(result);
  }
}

function terminalAuthorizationError(result: AuthorizationStatusResult): Error {
  return new Error(
    result.status === "expired"
      ? "Mailbox authorization expired before completion"
      : result.status === "denied"
        ? "Mailbox authorization was denied"
        : result.status === "used"
          ? "Mailbox authorization was already used"
          : "Mailbox authorization is no longer pending",
  );
}

async function defaultCredentialExists(
  account: PluginAccountConfig,
  options: Pick<StandardBindOptions, "config" | "stateDir">,
): Promise<boolean> {
  const target = resolvePluginAccountCredentialTarget({
    stateDir: options.stateDir,
    pluginAccountId: account.pluginAccountId,
    credentialRef: account.credentialRef,
    config: options.config,
  });
  try {
    await stat(target.filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) {
      return false;
    }
    throw error;
  }
}

function defaultReadCredential(
  account: PluginAccountConfig,
  options: Pick<StandardBindOptions, "config" | "stateDir">,
): string {
  return readPrivateAgentMailCredential(
    resolvePluginAccountCredentialTarget({
      stateDir: options.stateDir,
      pluginAccountId: account.pluginAccountId,
      credentialRef: account.credentialRef,
      config: options.config,
    }),
  );
}

async function defaultGetIdentityAddress(
  account: PluginAccountConfig,
  credential: string,
): Promise<string> {
  return await new AgentMailApiClient({
    baseUrl: account.apiBaseUrl,
    credential,
  }).getIdentityAddress();
}

function defaultCreateService(
  options: Pick<StandardBindOptions, "config" | "stateDir">,
): AuthorizationServiceLike {
  return new AgentMailAuthorizationService(options);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function normalizeMailboxAddress(value: string): string {
  const normalized = requireBoundedValue(value, "mailbox", 320);
  const parts = normalized.split("@");
  if (parts.length !== 2 || parts[0]!.length === 0 || parts[1]!.length === 0) {
    throw new Error("mailbox must contain exactly one valid @ separator");
  }
  return normalized;
}

function requireBoundedValue(
  value: string,
  label: string,
  maxLength: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new Error(`${label} must contain 1 to ${String(maxLength)} characters`);
  }
  return normalized;
}

function sameMailboxAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
