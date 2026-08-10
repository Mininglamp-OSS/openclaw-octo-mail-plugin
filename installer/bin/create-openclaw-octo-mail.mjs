#!/usr/bin/env node

import { runInstallerCli } from "../lib/installer.mjs";

try {
  const exitCode = runInstallerCli(process.argv.slice(2), process.env);
  process.exitCode = exitCode;
} catch (error) {
  process.stderr.write(
    `create-openclaw-octo-mail: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
