import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import { describe, expect, it } from "vitest";

import {
  getPrivateCredentialFilePath,
  resolvePluginAccountCredentialTarget,
  resolvePrivateCredentialFileTarget,
  writePrivateAgentMailCredential,
} from "./private-credential-file.js";

describe("plugin-owned private credential file", () => {
  it("derives an isolated private path for an auto-discovered Bot account", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-state-"));
    const target = resolvePluginAccountCredentialTarget({
      stateDir,
      pluginAccountId: "mail_bot_support_hash",
      config: {} as OpenClawConfig,
    });
    expect(target.filePath).toBe(
      getPrivateCredentialFilePath(stateDir, "mail_bot_support_hash"),
    );
    expect(target.filePath.startsWith(target.rootDir)).toBe(true);
  });

  it("atomically creates and rotates the configured account file with private permissions", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-state-"));
    const pluginAccountId = "support-agent";
    const filePath = getPrivateCredentialFilePath(stateDir, pluginAccountId);
    const ref: SecretRef = {
      source: "file",
      provider: "octo_support",
      id: "value",
    };
    const config = configForFileProvider(ref.provider, filePath);
    const target = resolvePrivateCredentialFileTarget({
      stateDir,
      pluginAccountId,
      ref,
      config,
    });

    const first = testCredential("first");
    const rotated = testCredential("rotated");
    await writePrivateAgentMailCredential(target, first);
    expect(await readFile(filePath, "utf8")).toBe(first);
    await writePrivateAgentMailCredential(target, rotated);
    expect(await readFile(filePath, "utf8")).toBe(rotated);

    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(filePath))).mode & 0o777).toBe(0o700);
  });

  it("fails closed when the provider points outside the account-owned path", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-state-"));
    const ref: SecretRef = {
      source: "file",
      provider: "octo_support",
      id: "value",
    };
    const config = configForFileProvider(
      ref.provider,
      join(stateDir, "wrong.credential"),
    );

    expect(() =>
      resolvePrivateCredentialFileTarget({
        stateDir,
        pluginAccountId: "support-agent",
        ref,
        config,
      }),
    ).toThrow(/does not match its Plugin Account/);
  });

  it("rejects env, JSON, and insecure file providers", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "octo-mail-state-"));
    const filePath = getPrivateCredentialFilePath(stateDir, "support-agent");
    const base = {
      stateDir,
      pluginAccountId: "support-agent",
    };

    expect(() =>
      resolvePrivateCredentialFileTarget({
        ...base,
        ref: { source: "env", provider: "default", id: "OCTO_MAIL" },
        config: {} as OpenClawConfig,
      }),
    ).toThrow(/singleValue file SecretRef/);

    expect(() =>
      resolvePrivateCredentialFileTarget({
        ...base,
        ref: { source: "file", provider: "octo_support", id: "value" },
        config: {
          secrets: {
            providers: {
              octo_support: { source: "file", path: filePath, mode: "json" },
            },
          },
        } as OpenClawConfig,
      }),
    ).toThrow(/file\/singleValue/);

    expect(() =>
      resolvePrivateCredentialFileTarget({
        ...base,
        ref: { source: "file", provider: "octo_support", id: "value" },
        config: {
          secrets: {
            providers: {
              octo_support: {
                source: "file",
                path: filePath,
                mode: "singleValue",
                allowInsecurePath: true,
              },
            },
          },
        } as OpenClawConfig,
      }),
    ).toThrow(/secure path checks/);
  });
});

function configForFileProvider(
  provider: string,
  path: string,
): OpenClawConfig {
  return {
    secrets: {
      providers: {
        [provider]: { source: "file", path, mode: "singleValue" },
      },
    },
  } as OpenClawConfig;
}

function testCredential(suffix: string): string {
  return ["omb", "local", "writer", suffix].join("_");
}
