import assert from "node:assert/strict";
import test from "node:test";

import {
  parseArguments,
  runInstallerCli,
} from "../lib/installer.mjs";

test("installs a missing local plugin before setup and bind", () => {
  const calls = [];
  const statuses = [1, 0, 0, 0];
  const result = runInstallerCli(
    [
      "bind",
      "--mailbox",
      "support@example.test",
      "--api-url",
      "https://octo.example.test",
      "--agent",
      "support-agent",
      "--space-id",
      "space-support",
      "--plugin-source",
      "/workspace/openclaw-octo-mail-plugin",
    ],
    {},
    {
      run(args, options) {
        calls.push({ args, options });
        return statuses.shift();
      },
    },
  );

  assert.equal(result, 0);
  assert.deepEqual(calls, [
    {
      args: ["plugins", "inspect", "octo-mail", "--json"],
      options: { quiet: true },
    },
    {
      args: [
        "plugins",
        "install",
        "--link",
        "/workspace/openclaw-octo-mail-plugin",
      ],
      options: { quiet: false },
    },
    {
      args: ["octo-mail", "setup"],
      options: { quiet: false },
    },
    {
      args: [
        "octo-mail",
        "bind",
        "--mailbox",
        "support@example.test",
        "--agent",
        "support-agent",
        "--space-id",
        "space-support",
        "--api-url",
        "https://octo.example.test",
      ],
      options: { quiet: false },
    },
  ]);
});

test("skips installation when the plugin is already present", () => {
  const calls = [];
  runInstallerCli(
    [
      "bind",
      "--mailbox",
      "support@example.test",
      "--agent",
      "agent-a",
      "--space-id",
      "space-support",
    ],
    {},
    {
      run(args) {
        calls.push(args);
        return 0;
      },
    },
  );
  assert.deepEqual(calls, [
    ["plugins", "inspect", "octo-mail", "--json"],
    ["octo-mail", "setup"],
    [
      "octo-mail",
      "bind",
      "--mailbox",
      "support@example.test",
      "--agent",
      "agent-a",
      "--space-id",
      "space-support",
    ],
  ]);
});

test("uses the public npm plugin source when a clean host has no plugin", () => {
  const calls = [];
  const statuses = [1, 0, 0, 0];
  runInstallerCli(
    [
      "bind",
      "--mailbox",
      "support@example.test",
      "--agent",
      "agent-a",
      "--space-id",
      "space-support",
    ],
    {},
    {
      run(args) {
        calls.push(args);
        return statuses.shift();
      },
    },
  );
  assert.deepEqual(calls[1], [
    "plugins",
    "install",
    "npm:openclaw-octo-mail-plugin",
  ]);
});

test("installs a packaged plugin artifact without source linking", () => {
  const calls = [];
  const statuses = [1, 0, 0, 0];
  runInstallerCli(
    [
      "bind",
      "--mailbox",
      "support@example.test",
      "--agent",
      "agent-a",
      "--space-id",
      "space-support",
      "--plugin-source",
      "/artifacts/openclaw-octo-mail-plugin-0.0.0.tgz",
    ],
    {},
    {
      run(args) {
        calls.push(args);
        return statuses.shift();
      },
    },
  );
  assert.deepEqual(calls[1], [
    "plugins",
    "install",
    "/artifacts/openclaw-octo-mail-plugin-0.0.0.tgz",
  ]);
});

test("stops immediately when installation fails", () => {
  const calls = [];
  assert.throws(
    () =>
      runInstallerCli(
        [
          "bind",
          "--mailbox",
          "support@example.test",
          "--agent",
          "agent-a",
          "--space-id",
          "space-support",
          "--plugin-source",
          "/plugin",
        ],
        {},
        {
          run(args) {
            calls.push(args);
            return calls.length === 1 ? 1 : 7;
          },
        },
      ),
    /plugin install failed with exit code 7/,
  );
  assert.equal(calls.length, 2);
});

test("rejects secret and unknown command-line options", () => {
  assert.throws(
    () =>
      parseArguments([
        "bind",
        "--mailbox",
        "support@example.test",
        "--agent",
        "agent-a",
        "--bot-token",
        "bf_secret",
      ]),
    /unknown option: --bot-token/,
  );
});

test("requires an explicit Space id for mailbox authorization", () => {
  assert.throws(
    () =>
      parseArguments([
        "bind",
        "--mailbox",
        "support@example.test",
        "--agent",
        "agent-a",
      ]),
    /--space-id is required/,
  );
});
