type CredentialActivationListener = (
  pluginAccountId: string,
) => void | Promise<void>;

const listeners = new Set<CredentialActivationListener>();

/**
 * Notify the one full Gateway runtime after a tool-discovery context stores a
 * new credential. Only the non-secret Plugin Account id crosses this process-
 * local boundary; the full runtime re-reads the credential from private
 * storage.
 */
export async function notifyCredentialActivation(
  pluginAccountId: string,
): Promise<void> {
  await Promise.all([...listeners].map((listener) => listener(pluginAccountId)));
}

export function subscribeCredentialActivation(
  listener: CredentialActivationListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
