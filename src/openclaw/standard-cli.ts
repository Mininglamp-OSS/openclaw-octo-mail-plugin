import type {
  OpenClawConfig,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

import { parsePluginConfig } from "../config/plugin-config.js";
import { resolveRuntimePluginAccounts } from "../accounts/plugin-account-source.js";
import { PLUGIN_ID } from "../constants.js";
import {
  configureStandardPlugin,
  OCTO_MAIL_TOOL_NAMES,
} from "./standard-setup.js";
import { bindStandardMailbox } from "./standard-bind.js";

interface StatusCliOptions {
  agent?: string;
}

interface BindCliOptions {
  mailbox: string;
  agent: string;
  spaceId: string;
  apiUrl?: string;
  wait?: boolean;
}

/** Register the plugin-owned standard OpenClaw CLI surface. */
export function registerOctoMailCli(api: OpenClawPluginApi): void {
  api.registerCli(
    ({ program, config }) => {
      const root = program
        .command("octo-mail")
        .description("Configure and inspect OCTO Agent Mail");

      root
        .command("setup")
        .description(
          "Enable Agent Mail for all current and future OCTO Bot bindings",
        )
        .action(async () => {
          const committed = await api.runtime.config.mutateConfigFile({
            afterWrite: {
              mode: "restart",
              reason: "OCTO Agent Mail global tool policy changed",
            },
            mutate(draft) {
              return configureStandardPlugin(draft);
            },
          });
          const result = committed.result;
          if (result === undefined) {
            throw new Error("OCTO Agent Mail setup returned no result");
          }
          console.log(
            [
              "OCTO Agent Mail configured.",
              `Discovered Agent/Bot mappings: ${String(result.discoveredAccounts)}`,
              `Mapping issues: ${String(result.mappingIssues)}`,
              "Future explicit OCTO Bot bindings are discovered automatically.",
              "Restart OpenClaw if it is not restarted automatically.",
            ].join("\n"),
          );
        });

      root
        .command("bind")
        .description("Start owner-approved mailbox binding for one Agent")
        .requiredOption("--mailbox <address>", "mailbox address to authorize")
        .requiredOption("--agent <agent-id>", "exact OpenClaw Agent id")
        .requiredOption(
          "--space-id <space-id>",
          "exact OCTO Space id from the mailbox setup prompt",
        )
        .option(
          "--api-url <origin>",
          "assert the public OCTO origin from the trusted Bot binding",
        )
        .option(
          "--wait",
          "wait in this terminal until authorization completes",
          false,
        )
        .action(async (options: BindCliOptions) => {
          const rawConfig = config.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
          const result = await bindStandardMailbox({
            config,
            pluginConfig: parsePluginConfig(rawConfig),
            stateDir: resolveStateDir(),
            agentId: options.agent,
            mailboxAddress: options.mailbox,
            spaceId: options.spaceId,
            ...(options.apiUrl === undefined
              ? {}
              : { apiUrl: options.apiUrl }),
            wait: options.wait === true,
            onAuthorizationRequired(authorization) {
              console.log(
                [
                  "Mailbox owner authorization is required.",
                  `Open: ${authorization.verificationUri}`,
                  `Code: ${authorization.userCode}`,
                  `Expires: ${authorization.expiresAt}`,
                ].join("\n"),
              );
            },
          });
          if (result.status === "connected") {
            console.log(
              result.alreadyConnected
                ? `Mailbox already connected: ${result.mailboxAddress}`
                : `Mailbox connected: ${result.mailboxAddress}`,
            );
            return;
          }
          console.log(
            [
              `Requested mailbox: ${result.mailboxAddress}`,
              "After approval, ask the Agent to check the mailbox connection status.",
            ].join("\n"),
          );
        });

      root
        .command("status")
        .description("Show Agent Mail setup without exposing credentials")
        .option("--agent <agent-id>", "filter by OpenClaw Agent id")
        .action((options: StatusCliOptions) => {
          console.log(formatStandardStatus(config, options.agent));
        });
    },
    {
      descriptors: [
        {
          name: "octo-mail",
          description: "Configure and inspect OCTO Agent Mail",
          hasSubcommands: true,
        },
      ],
    },
  );
}

export function formatStandardStatus(
  config: OpenClawConfig,
  agentFilter?: string,
): string {
  const rawConfig = config.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
  const parsed = parsePluginConfig(rawConfig);
  const discovery = resolveRuntimePluginAccounts(config, parsed);
  const normalizedFilter = agentFilter?.trim();
  const accounts = discovery.accounts.filter(
    (account) =>
      normalizedFilter === undefined || account.agentId === normalizedFilter,
  );
  if (accounts.length === 0) {
    const base = normalizedFilter
      ? `OCTO Agent Mail has no valid OCTO Bot mapping for Agent ${normalizedFilter}.`
      : "OCTO Agent Mail is installed but no valid OCTO Bot mapping was discovered.";
    return base + formatIssues(discovery.issues, normalizedFilter);
  }
  return accounts
    .map((account) => {
      const agent = config.agents?.list?.find(
        (candidate) => candidate.id === account.agentId,
      );
      const allowed = new Set([
        ...(config.tools?.alsoAllow ?? []),
        ...(agent?.tools?.alsoAllow ?? []),
      ]);
      const denied = new Set([
        ...(config.tools?.deny ?? []),
        ...(agent?.tools?.deny ?? []),
      ]);
      const missingTools = OCTO_MAIL_TOOL_NAMES.filter(
        (toolName) => !allowed.has(toolName) || denied.has(toolName),
      );
      return [
        `Plugin Account: ${account.pluginAccountId}`,
        `Agent: ${account.agentId}`,
        `OCTO Bot: ${account.botId}`,
        `OCTO origin: ${account.apiBaseUrl}`,
        `Enabled: ${String(account.enabled)}`,
        missingTools.length === 0
          ? "Tool policy: ready"
          : `Tool policy: missing ${missingTools.join(", ")}`,
      ].join("\n");
    })
    .join("\n\n") + formatIssues(discovery.issues, normalizedFilter);
}

function formatIssues(
  issues: ReturnType<typeof resolveRuntimePluginAccounts>["issues"],
  agentFilter: string | undefined,
): string {
  const relevant = issues.filter(
    (issue) => agentFilter === undefined || issue.agentId === agentFilter,
  );
  return relevant.length === 0
    ? ""
    : `\n\nMapping issues:\n${relevant.map((issue) => `- ${issue.message}`).join("\n")}`;
}
