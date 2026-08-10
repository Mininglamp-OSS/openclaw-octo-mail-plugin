## What changed

<!-- Describe the change and why it is needed. Link the issue if one exists. -->

Closes #

## Type of change

- [ ] `feat` — new capability
- [ ] `fix` — bug fix
- [ ] `refactor` — no behaviour change
- [ ] `perf` — performance
- [ ] `docs` / `test` / `chore` / `ci`

## Test plan

<!--
List what you actually ran, not what should pass. Paste relevant output.
`npm run check` is the required local gate.
-->

- [ ] `npm run check` passes locally (typecheck + vitest + installer tests + build)
- [ ] New or changed behaviour is covered by a test
- [ ] Manually verified against a real OCTO deployment (describe how, or state N/A)

## Security boundaries

This plugin handles mailbox credentials and untrusted email content. Confirm the
boundaries below still hold, or explain why the box does not apply.

- [ ] No credential, confirmation token, or secret is written to `openclaw.json`,
      command-line arguments, or logs
- [ ] Email content, HTML, links, and attachments are still treated as untrusted
      input and cannot grant permissions
- [ ] Write authorization is still enforced by octo-mail — prompt text and plugin
      configuration cannot enable automatic send
- [ ] Ambiguous or missing Agent / Bot / account / mailbox identity still fails
      closed
- [ ] No new dependency added, or the addition is justified below

## Compatibility

- [ ] No change to the plugin API contract (`openclaw.plugin.json`, `compat.pluginApi`)
- [ ] No change to the Mail Tool surface exposed to Agents
- [ ] Breaking change — described below with a migration note

## Notes for reviewers

<!-- Anything worth pointing at first: risky hunks, trade-offs, follow-up work. -->
