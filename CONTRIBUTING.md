# Contributing

## Development environment

Node is pinned by `.nvmrc`. The `engines` field additionally allows Node 22
(`>=22.22.3`) and Node 25 (`>=25.9.0`), but CI runs the `.nvmrc` version.

```bash
nvm use            # reads .nvmrc → 24.15.0
npm ci
```

`installer/` is a separate package with no dependencies — it needs no install
step; its tests run on the Node built-in test runner.

## Local gate

`npm run check` is the required gate before opening a pull request. It is the
same command CI runs:

```bash
npm run check
```

It chains four stages, and stops at the first failure:

| Stage             | Command                    | Covers                              |
| ----------------- | -------------------------- | ----------------------------------- |
| `typecheck`       | `tsc -p tsconfig.json`     | Types across `src/`, no emit        |
| `test`            | `vitest run`               | Unit tests next to each module      |
| `test:installer`  | `node --test`              | `installer/` behaviour              |
| `build`           | `tsc -p tsconfig.build.json` | Production `dist/` output         |

Useful single stages while iterating:

```bash
npm run typecheck
npm test -- src/auth          # scope vitest to a path
npm run test:installer
npm run pack:check            # inspect the publishable tarball
```

## Tests

Tests live next to the code as `<module>.test.ts` — keep that layout. Every
behaviour change needs a test that fails before the fix and passes after it.

Do not reach for the network in tests. Use `src/testing/synthetic-mail-client.ts`
and `src/testing/test-values.ts` for mail-client behaviour and fixtures.

## Branches and commits

Branch off `main`:

```
feat/<short-slug>
fix/<short-slug>
refactor/<short-slug>
chore/<short-slug>
```

Commits follow Conventional Commits:

```
<type>: <imperative description>

<optional body explaining why, not what>
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.

## Pull requests

`main` is protected — it takes no direct pushes.

1. Push your branch and open a pull request against `main`.
2. Fill in the pull request template, including the security-boundary section.
3. CI (`check`) must pass. Failing CI blocks merge.
4. One approval is required. `@Mininglamp-OSS/maintainers` is requested
   automatically via `.github/CODEOWNERS`.
5. Resolve every review thread before merging.
6. Pushing new commits dismisses earlier approvals — re-request review.

**Squash merge is preferred**, so `main` keeps one commit per change. Use a merge
commit only when the individual commits carry meaning worth keeping.

Administrators can bypass these rules. Reserve that for incidents, and follow up
with a regular pull request describing what was bypassed and why.

## Security boundaries

These are load-bearing invariants, not style preferences. A change that weakens
one needs an explicit rationale in the pull request.

- Email content, HTML, links, and attachments are **untrusted input**. They must
  never be able to grant a permission or steer a tool call.
- Mailbox credentials and confirmation tokens must never reach `openclaw.json`,
  command-line arguments, or logs. They live only in the plugin-owned secret
  boundary — see `src/auth/private-credential-file.ts` and `src/auth/secret-ref.ts`.
- JMAP Agent credentials are read-only. Writes go through controlled WebAPI
  operations only.
- Write authorization is enforced by octo-mail. Prompt text and plugin
  configuration cannot grant automatic-send permission.
- Routing **fails closed** when Agent, Bot, account, or mailbox identity is
  ambiguous or missing.
- Write timeouts have an unknown outcome and are never retried automatically.

Found a vulnerability? Do not open a public issue — report it privately to the
maintainers first.
