# Track architecture check

Phase A keeps native SDK calls out of pure policy and prevents new import cycles
while Track is split into small modules. This is a development dependency, not a
runtime component. The existing `typecheck` job runs
`tests/helpers/architecture.ts` after both original compiler checks; any nonzero
result fails landing. This placement matters: `land.sh` prepares the pinned SDK
and npm dependencies after its standalone Bun-helper loop. The architecture
check needs both, so it runs in the later package job without editing land.sh.

Prerequisites: the existing Node/Bun toolchain, `uv`, Python 3.12 or later, Track's
locked npm dependencies and the reviewed native SDK input described in the root
README. Do not replace generated SDK declarations with stubs.

From the repository root, warm the locked tool environment once:

```sh
npm --prefix track ci --ignore-scripts --include=dev --no-audit --no-fund
uv sync --project track/architecture --frozen
bun track/tests/helpers/architecture.ts
```

The helper derives absolute paths from its own location. It also works from
`track/` as `bun tests/helpers/architecture.ts`. A cold cache needs network
access. With an unavailable tool, cache, compiler or SDK input, it reports
`BLOCKED` and exits 2; it never skips the check. A valid rule violation exits 1.
Only a valid passing report exits 0.

`architecture/tsconfig.json` extends the real native compiler configuration and
selects production hooks and public declarations for import analysis. It excludes
tests from this graph. The unchanged full native and helper typechecks still run
through `npm --prefix track run typecheck`.

The pinned extractor does not show public declaration files, and can omit SDK
imports resolved to those declarations. The same helper therefore checks static
SDK import/export specifiers with TypeScript's syntax tree before import
resolution. Only the current native adapter, `hooks/register.tsx`, may name the
SDK. It also covers `import type`; an architecture change must explicitly revise
that adapter boundary. Python subprocess and dynamic-import links still require
native fixtures and consumer checks. A passing graph is not full runtime proof.

The baseline is empty. The existing capacity type cycle is visible in the raw
graph; the narrow `type_only` exception already covers it in the rule check, so
its redundant cycle baseline was removed. A forbidden return edge rejects a
value import. Keep type-only imports included. New
components, external packages or allowances require an explicit design change;
the baseline must only shrink during this refactor.

Ordinary maintained modules should be around 100 lines with one reason to change.
Generated lockfiles and engine-written declarations are not handwritten modules.
The first extraction is only a foundation for that architecture, not completion
of the full Track refactor.
