# Contributing

Thanks for helping make the ledger more honest.

## The bar

Every change should make **a number more true, a waste more visible, or a fix
more automatic**. Concretely:

1. **Honesty first.** Never report a number we can't defend. Prefer transcript
   ground truth over estimates, and NET savings over gross.
2. **Silence is a feature.** Hooks stay under ~10ms and inject nothing that
   isn't actionable.
3. **No dependencies.** CCO is Node built-ins only, and stays that way.
4. **Tests for new pure logic.** CI runs Node 18/20/22 plus CodeQL.

## Setup

```bash
git clone https://github.com/egorfedorov/claude-context-optimizer
cd claude-context-optimizer
node tests/test.js      # no install step — zero dependencies
```

Most modules are runnable directly for a smoke test:

```bash
node src/overhead.js        # session baseline audit
node src/dashboard.js       # /cco screen
```

## Making a change

- Branch off `main` (`fix/…`, `feat/…`, `docs/…`), open a PR against `main`.
- Keep pure logic exported and covered in `tests/test.js` — the hook entry
  points are guarded by `isMainModule()` precisely so tests can import them
  without the module blocking on stdin.
- Update `CHANGELOG.md` under an `## Unreleased` heading for user-visible
  changes.
- Reference the issue you're closing (`Closes #NN`).

## Platform notes

CCO runs on macOS, Linux and Windows. When touching paths:

- Use `toPosixPath()` from `src/utils.js` before splitting or glob-matching —
  Windows hands you `\`.
- Use `path.dirname` / `path.join`, never a `/`-hardcoded regex, to walk
  directories.
- Parse text files with `split(/\r?\n/)`, not `split('\n')` — user-authored
  files on Windows are CRLF.

## Releasing (maintainers)

1. Bump `version` in `package.json` (single source of truth).
2. `npm run sync-version` — propagates to `.claude-plugin/plugin.json`,
   `.claude-plugin/marketplace.json` and `docs/index.html`, and warns if the
   external `egorfedorov/claude-plugins` marketplace is stale (that repo must
   be updated separately).
3. Update `CHANGELOG.md` and the README "What's new" section.
4. Branch → PR → merge → `git tag vX.Y.Z` → `gh release create`.

## License

Contributions are accepted under the [MIT License](LICENSE).
