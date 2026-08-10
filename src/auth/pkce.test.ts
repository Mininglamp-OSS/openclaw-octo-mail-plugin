import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPkcePair } from "./pkce.js";

describe("Agent Mail PKCE", () => {
  it("creates a 256-bit verifier and S256 challenge", () => {
    const pair = createPkcePair(() => Uint8Array.from({ length: 32 }, (_, i) => i));

    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(
      createHash("sha256").update(pair.verifier).digest("base64url"),
    );
  });

  it("fails closed on a broken entropy source", () => {
    expect(() => createPkcePair(() => new Uint8Array(31))).toThrow(
      /exactly 32 bytes/,
    );
  });
});
