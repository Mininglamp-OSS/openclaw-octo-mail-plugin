import { spawnSync } from "node:child_process";

const PLUGIN_ID = "octo-mail";
const DEFAULT_PLUGIN_SOURCE = "npm:openclaw-octo-mail-plugin";

export function runInstallerCli(
  argv,
  environment = process.env,
  dependencies = {},
) {
  const options = parseArguments(argv);
  if (options.help) {
    (dependencies.writeOutput ?? defaultWriteOutput)(usage());
    return 0;
  }
  const run = dependencies.run ?? runOpenClaw;
  const pluginSource =
    options.pluginSource ??
    nonEmpty(environment.OPENCLAW_OCTO_MAIL_PLUGIN_SOURCE) ??
    DEFAULT_PLUGIN_SOURCE;

  const inspected = run(
    ["plugins", "inspect", PLUGIN_ID, "--json"],
    { quiet: true },
  );
  if (inspected !== 0) {
    const installArguments = isLocalDirectorySource(pluginSource)
      ? ["plugins", "install", "--link", pluginSource]
      : ["plugins", "install", pluginSource];
    requireSuccess(run(installArguments, { quiet: false }), "plugin install");
  }

  requireSuccess(run(["octo-mail", "setup"], { quiet: false }), "plugin setup");

  const bindArguments = [
    "octo-mail",
    "bind",
    "--mailbox",
    options.mailbox,
    "--agent",
    options.agent,
    "--space-id",
    options.spaceId,
  ];
  if (options.apiUrl !== undefined) {
    bindArguments.push("--api-url", options.apiUrl);
  }
  if (options.wait) {
    bindArguments.push("--wait");
  }
  requireSuccess(run(bindArguments, { quiet: false }), "mailbox binding");
  return 0;
}

export function parseArguments(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { help: true };
  }
  if (argv[0] !== "bind") {
    throw new Error("expected the bind command");
  }
  const values = new Map();
  let wait = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--wait") {
      wait = true;
      continue;
    }
    if (
      argument !== "--mailbox" &&
      argument !== "--agent" &&
      argument !== "--space-id" &&
      argument !== "--api-url" &&
      argument !== "--plugin-source"
    ) {
      throw new Error(`unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (values.has(argument)) {
      throw new Error(`${argument} may only be supplied once`);
    }
    values.set(argument, value);
    index += 1;
  }
  const mailbox = requireOption(values, "--mailbox");
  const agent = requireOption(values, "--agent");
  const spaceId = requireOption(values, "--space-id");
  return {
    help: false,
    mailbox,
    agent,
    spaceId,
    apiUrl: values.get("--api-url"),
    pluginSource: values.get("--plugin-source"),
    wait,
  };
}

function runOpenClaw(argumentsList, options) {
  const result = spawnSync("openclaw", argumentsList, {
    stdio: options.quiet ? "ignore" : "inherit",
    shell: false,
  });
  if (result.error !== undefined) {
    throw new Error(
      result.error.code === "ENOENT"
        ? "OpenClaw is not installed or is not available on PATH"
        : `failed to run OpenClaw: ${result.error.message}`,
    );
  }
  return result.status ?? 1;
}

function requireSuccess(status, step) {
  if (status !== 0) {
    throw new Error(`${step} failed with exit code ${String(status)}`);
  }
}

function requireOption(values, name) {
  const value = values.get(name);
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function isLocalDirectorySource(value) {
  if (!isLocalPath(value)) {
    return false;
  }
  return !/\.(?:tgz|tar\.gz|zip)$/iu.test(value);
}

function isLocalPath(value) {
  return (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function defaultWriteOutput(value) {
  process.stdout.write(`${value}\n`);
}

function usage() {
  return [
    "Usage:",
    "  create-openclaw-octo-mail bind --mailbox <address> --agent <agent-id> --space-id <space-id> [options]",
    "",
    "Options:",
    "  --space-id <space-id>   Exact OCTO Space id from the mailbox setup prompt",
    "  --api-url <origin>       Assert the OCTO origin from the trusted Bot binding",
    "  --plugin-source <source> Local plugin path or future package source",
    "  --wait                   Wait for owner authorization in this terminal",
    "  -h, --help               Show this help",
    "",
    "The command never accepts a Bot token, omb_ credential, or CLI profile.",
  ].join("\n");
}
