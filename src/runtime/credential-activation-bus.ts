import type { PluginAccountConfig } from "../accounts/plugin-account.js";

type CredentialActivationListener = (
  account: PluginAccountConfig,
) => void | Promise<void>;

const listeners = new Set<CredentialActivationListener>();

/**
 * Notify the one full Gateway runtime after a tool-discovery context stores a
 * new credential. Only validated, non-secret Plugin Account configuration
 * crosses this process-local boundary; the full runtime re-reads the credential
 * from private storage.
 */
export async function notifyCredentialActivation(
  account: PluginAccountConfig,
): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener(account)));
}

export function subscribeCredentialActivation(
  listener: CredentialActivationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
