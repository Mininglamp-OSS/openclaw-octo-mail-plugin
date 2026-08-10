import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";

import {
  parseAgentMailCredentialRef,
  resolveAgentMailCredential,
} from "./secret-ref.js";

describe("Agent Mail SecretRef boundary", () => {
  it("accepts only a canonical structured SecretRef", () => {
    expect(
      parseAgentMailCredentialRef({
        source: "file",
        provider: "octo_mail",
        id: "value",
      }),
    ).toEqual({ source: "file", provider: "octo_mail", id: "value" });

    expect(() => parseAgentMailCredentialRef("omb_not_in_config")).toThrow(
      /structured OpenClaw SecretRef/,
    );
    expect(() =>
      parseAgentMailCredentialRef({
        source: "file",
        provider: "octo_mail",
        id: "value",
        credential: "not-allowed",
      }),
    ).toThrow(/unknown keys: credential/);
  });

  it("resolves a private single-value file provider through the public OpenClaw API", async () => {
    const credential = testCredential();
    const { config, ref } = await createFileProvider(credential);

    await expect(
      resolveAgentMailCredential({ ref, config }),
    ).resolves.toBe(credential);
  });

  it.each([
    ["empty", ""],
    ["empty omb payload", "omb_"],
    ["wrong prefix", "owner_token_for_test"],
  ])("fails closed when a file provider resolves an %s value", async (_, value) => {
    const { config, ref } = await createFileProvider(value);

    await expect(resolveAgentMailCredential({ ref, config })).rejects.toThrow(
      /empty or non-string|omb_/,
    );
  });

  it("fails closed when a JSON provider resolves a non-string value", async () => {
    const directory = await mkdtemp(join(tmpdir(), "octo-mail-secret-ref-"));
    const path = join(directory, "secrets.json");
    await writeFile(path, JSON.stringify({ credential: 42 }), {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path, 0o600);
    const ref: SecretRef = {
      source: "file",
      provider: "octo_mail",
      id: "/credential",
    };
    const config = {
      secrets: {
        providers: {
          octo_mail: { source: "file", path, mode: "json" },
        },
      },
    } as OpenClawConfig;

    await expect(resolveAgentMailCredential({ ref, config })).rejects.toThrow(
      /empty or non-string/,
    );
  });
});

async function createFileProvider(value: string): Promise<{
  config: OpenClawConfig;
  ref: SecretRef;
}> {
  const directory = await mkdtemp(join(tmpdir(), "octo-mail-secret-ref-"));
  const path = join(directory, "credential.txt");
  await writeFile(path, `${value}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return {
    ref: { source: "file", provider: "octo_mail", id: "value" },
    config: {
      secrets: {
        providers: {
          octo_mail: { source: "file", path, mode: "singleValue" },
        },
      },
    } as OpenClawConfig,
  };
}

function testCredential(): string {
  return ["omb", "local", "secretref", "test"].join("_");
}
