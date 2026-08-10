import { createHash, randomBytes } from "node:crypto";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function createPkcePair(
  generateBytes: (size: number) => Uint8Array = randomBytes,
): PkcePair {
  const entropy = generateBytes(32);
  if (!(entropy instanceof Uint8Array) || entropy.byteLength !== 32) {
    throw new Error("Agent Mail PKCE generator must return exactly 32 bytes");
  }
  const verifier = Buffer.from(entropy).toString("base64url");
  const challenge = createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}
