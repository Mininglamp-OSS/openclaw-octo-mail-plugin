import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { join } from "node:path";

import { parsePluginConfig, pluginConfigSchema } from "./config/plugin-config.js";
import {
  MAIL_AUTHORIZATION_SERVICE_ID,
  MAIL_AUTO_REPLY_TOOL_NAME,
  MAIL_CONNECTION_STATUS_TOOL_NAME,
  MAIL_CONNECT_TOOL_NAME,
  MAIL_GET_MESSAGE_TOOL_NAME,
  MAIL_REPLY_TOOL_NAME,
  MAIL_SEND_TOOL_NAME,
  PLUGIN_ID,
} from "./constants.js";
import { PluginAccountCatalog } from "./accounts/plugin-account.js";
import { PluginAccountRuntimeRegistry } from "./accounts/account-runtime-registry.js";
import { resolveRuntimePluginAccounts } from "./accounts/plugin-account-source.js";
import { AgentMailAuthorizationService } from "./auth/agent-mail-authorization-service.js";
import { createOpenClawInboundMailDispatcher } from "./openclaw/agent-dispatcher.js";
import { OpenClawOwnerDraftNotifier } from "./openclaw/owner-draft-notifier.js";
import { registerOctoMailCli } from "./openclaw/standard-cli.js";
import { buildMailToolGuidance } from "./openclaw/mail-tool-guidance.js";
import { createMailAuthorizationToolFactory } from "./tools/mail-authorization-tools.js";
import { createAccountMailToolFactory } from "./tools/account-mail-tools.js";
import { AgentMailRuntimeController } from "./runtime/agent-mail-runtime-controller.js";
import { AccountDiscoveryManager } from "./discovery/account-discovery-manager.js";
import {
  notifyCredentialActivation,
  subscribeCredentialActivation,
} from "./runtime/credential-activation-bus.js";
import { FileMailWorkflowStateStore } from "./runtime/mail-workflow-state-store.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: PLUGIN_ID,
  name: "OCTO Agent Mail",
  description: "Long-running OpenClaw integration for OCTO Agent Mail",
  configSchema: pluginConfigSchema,
  reload: {
    restartPrefixes: [
      "plugins.enabled",
      "plugins.allow",
      "plugins.deny",
      "plugins.entries.octo-mail",
      "tools",
      "agents.list",
      "bindings",
      "channels.octo",
    ],
  },
  register(api) {
    registerOctoMailCli(api);
    const config = parsePluginConfig(api.pluginConfig);
    const fullRegistration = api.registrationMode === "full";
    const workflowState = new FileMailWorkflowStateStore(
      join(
        resolveStateDir(),
        "plugins",
        "octo-mail",
        "mail-workflow-state.json",
      ),
    );
    const ownerDraftNotifier = new OpenClawOwnerDraftNotifier({
      api,
      state: workflowState,
      logger: api.logger,
    });
    const accountSource = resolveRuntimePluginAccounts(api.config, config);
    const accountCatalog = new PluginAccountCatalog(accountSource.accounts);
    const accountRuntimes = new PluginAccountRuntimeRegistry(accountCatalog, {
      onAccountLoadError: (account) => {
        api.logger.warn(
          `[octo-mail] Plugin Account ${account.pluginAccountId} has an invalid or revoked stored credential; only that account is paused until re-authorization`,
        );
      },
    });
    const discoveryManager = fullRegistration
      ? new AccountDiscoveryManager({
          logger: api.logger,
          createDispatcher: (runtime) =>
            createOpenClawInboundMailDispatcher(
              api,
              runtime.config.agentId,
              api.logger,
            ),
        })
      : undefined;
    const runtimeController = new AgentMailRuntimeController({
      accountRuntimes,
      defaultContext: {
        config: api.config,
        stateDir: resolveStateDir(),
      },
      createAuthorizationService: async (context) => {
        const service = new AgentMailAuthorizationService({
          config: context.config,
          stateDir: context.stateDir,
          onCredentialStored: async (account, credential) => {
            const runtime = await accountRuntimes.activate(account, credential);
            if (discoveryManager !== undefined) {
              await discoveryManager.activate(runtime);
            } else {
              await notifyCredentialActivation(account);
            }
          },
          onBackgroundError: (account, error) => {
            api.logger.warn(
              `[octo-mail] automatic authorization completion stopped for Plugin Account ${account.pluginAccountId}: ${error instanceof Error ? error.message : String(error)}`,
            );
          },
        });
        await service.resumePending(accountCatalog.listAll());
        return service;
      },
      logStarted: () => {
        api.logger.info(
          `[octo-mail] authorization runtime started with ${String(accountSource.accounts.length)} discovered account(s) and ${String(accountSource.issues.length)} mapping issue(s)`,
        );
      },
      logStopped: () => {
        api.logger.info("[octo-mail] authorization runtime stopped");
      },
      onRuntimesStarted: async (context) => {
        await discoveryManager?.start(
          context.stateDir,
          accountRuntimes.listAll(),
        );
      },
      onRuntimesStopping: async () => {
        await discoveryManager?.stop();
      },
    });
    api.registerTool(
        createAccountMailToolFactory({
          catalog: accountCatalog,
          runtimes: accountRuntimes,
          ensureRuntimeStarted: async () => {
            await runtimeController.ensureStarted();
          },
          activateStoredRuntime: async (pluginAccountId) => {
            await runtimeController.ensureStarted();
            const runtime = await accountRuntimes.activateStored(
              accountCatalog.getById(pluginAccountId),
              {
                config: api.config,
                stateDir: resolveStateDir(),
              },
            );
            await discoveryManager?.activate(runtime);
            return runtime;
          },
          ownerDraftNotifier,
        }),
        {
          names: [
            MAIL_GET_MESSAGE_TOOL_NAME,
            MAIL_REPLY_TOOL_NAME,
            MAIL_SEND_TOOL_NAME,
            MAIL_AUTO_REPLY_TOOL_NAME,
          ],
          optional: true,
        },
    );
    api.registerTool(
        createMailAuthorizationToolFactory({
          catalog: accountCatalog,
          getService: async () => {
            return await runtimeController.ensureStarted();
          },
          getConnectedMailboxAddress: (pluginAccountId) => {
            try {
              return accountRuntimes.getById(pluginAccountId).mailboxAddress;
            } catch {
              return undefined;
            }
          },
        }),
        {
          names: [MAIL_CONNECT_TOOL_NAME, MAIL_CONNECTION_STATUS_TOOL_NAME],
          optional: true,
        },
    );
    if (api.registrationMode !== "full") {
      return;
    }

    api.on("before_prompt_build", (_event, context) => {
      const guidance = buildMailToolGuidance({
        messageProvider: context.messageProvider,
        agentId: context.agentId,
        accounts: accountCatalog.listAll(),
      });
      return guidance === null
        ? undefined
        : { prependSystemContext: guidance };
    });

    if (discoveryManager !== undefined) {
      let unsubscribeCredentialActivation: (() => void) | undefined;
      api.registerService({
        id: MAIL_AUTHORIZATION_SERVICE_ID,
        async start(ctx) {
          unsubscribeCredentialActivation = subscribeCredentialActivation(
            async (account) => {
              try {
                const registeredAccount = accountCatalog.register(account);
                const runtime = await accountRuntimes.activateStored(
                  registeredAccount,
                  { config: ctx.config, stateDir: ctx.stateDir },
                );
                await discoveryManager.activate(runtime);
              } catch (error) {
                api.logger.error(
                  `[octo-mail] failed to activate newly stored credential for Plugin Account ${account.pluginAccountId}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            },
          );
          await runtimeController.ensureStarted({
            config: ctx.config,
            stateDir: ctx.stateDir,
          });
        },
        async stop() {
          unsubscribeCredentialActivation?.();
          unsubscribeCredentialActivation = undefined;
          await runtimeController.stop();
        },
      });
      return;
    }
  },
});

export default plugin;
