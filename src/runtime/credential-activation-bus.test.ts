import { describe, expect, it, vi } from "vitest";

import {
  notifyCredentialActivation,
  subscribeCredentialActivation,
} from "./credential-activation-bus.js";
import type { PluginAccountConfig } from "../accounts/plugin-account.js";
import { TEST_OCTO_ORIGIN } from "../testing/test-values.js";

describe("credential activation bus", () => {
  it("broadcasts non-secret Plugin Account configuration and supports unsubscribe", async () => {
    const listener = vi.fn(async () => undefined);
    const unsubscribe = subscribeCredentialActivation(listener);
    const support = account("support");

    await notifyCredentialActivation(support);
    expect(listener).toHaveBeenCalledWith(support);
    expect(JSON.stringify(listener.mock.calls)).not.toContain("omb_");

    unsubscribe();
    await notifyCredentialActivation(account("sales"));
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

function account(pluginAccountId: string): PluginAccountConfig {
  return {
    pluginAccountId,
    enabled: true,
    agentId: `${pluginAccountId}-agent`,
    botId: `${pluginAccountId}-bot`,
    apiBaseUrl: TEST_OCTO_ORIGIN,
    discovery: { enabled: true, pollIntervalMs: 5_000, maxChanges: 100 },
  };
}
