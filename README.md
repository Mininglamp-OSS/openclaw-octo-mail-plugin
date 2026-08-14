# openclaw-octo-mail-plugin

OCTO Agent Mail plugin for standard OpenClaw.

The plugin runs with the OpenClaw Runtime, discovers new mailbox changes through
JMAP, dispatches Inbox events to the bound Agent, and exposes controlled Mail
Tools. It does not start `octo-cli` or model email as an IM channel.

## Capabilities

- Owner-authorized Agent mailbox connection
- Trusted Agent, Bot, Space, and mailbox routing
- JMAP EventSource with `Email/changes` recovery
- Incremental Inbox discovery and local cursor persistence
- Read, send, reply, and automatic-reply Mail Tools
- Manual-confirmation and server-authorized automatic-send modes
- Draft notification and Web Drafts handoff
- Untrusted-email prompt boundary
- Automatic-reply chain limits

## Requirements

- Node.js `22.22.3+` on Node 22, or a supported Node 24/25 release
- Standard `openclaw@2026.7.1`
- `openclaw-channel-octo` configured for the target Bot
- An OCTO deployment exposing `/agent-mail-api`

ClawX may be used as an OpenClaw distribution for local testing, but it is not a
runtime or packaging dependency.

## Install from source

```bash
npm ci
npm run check
openclaw plugins install --link /path/to/openclaw-octo-mail-plugin
openclaw octo-mail setup
```

## Connect a mailbox

```bash
openclaw octo-mail bind \
  --mailbox support@mail.example.com \
  --agent support-agent \
  --space-id <octo-space-id>
```

The command prints the owner-authorization URL. Mailbox credentials are stored
inside the plugin-owned secret boundary after approval; they must not be placed
in `openclaw.json` or passed through command-line arguments.

The thin installer can also be tested from this repository:

```bash
npx --yes ./installer bind \
  --plugin-source /path/to/openclaw-octo-mail-plugin \
  --mailbox support@mail.example.com \
  --agent support-agent \
  --space-id <octo-space-id>
```

## Configuration

The normal plugin configuration controls discovery only:

```json5
{
  discovery: {
    enabled: true,
    pollIntervalMs: 5000,
    maxChanges: 100,
  },
  accounts: [],
}
```

Agent/Bot/API mappings are derived from trusted `openclaw-channel-octo`
bindings. An ambiguous or missing mapping fails closed for the affected Agent.

## Mail Tools

- `mail_connect`
- `mail_connection_status`
- `mail_get_message`
- `mail_send`
- `mail_reply`
- `mail_auto_reply`

Write authorization is enforced by octo-mail. Prompt text and plugin
configuration cannot grant automatic-send permission.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run pack:check
```

`npm run check` runs the complete local gate, including installer tests and the
production build.

## Security boundaries

- Email content, HTML, links, and attachments are untrusted input.
- JMAP Agent credentials are read-only; writes use controlled WebAPI operations.
- Write timeouts have an unknown outcome and are not retried automatically.
- The account-scoped `omb_` credential stays inside the Plugin account runtime
  and is never exposed through Agent-visible tool inputs, outputs, prompts,
  normal OpenClaw configuration, or logs.
- Owner-confirmed delivery relies on the trusted direct-session Owner gate; a
  shared OpenClaw instance containing Bots owned by different people is not
  supported by this design.
- Routing fails closed when Agent, Bot, account, or mailbox identity is
  ambiguous.
