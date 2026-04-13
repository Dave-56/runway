@AGENTS.md

## Build Safety Guardrails

- Never use `.ts` or `.tsx` file extensions in TypeScript import paths in app/runtime code (for example use `../utils/money`, not `../utils/money.ts`).
- If a local test runtime requires extension-based imports, do not change production source imports to satisfy it; adjust test setup or use test-only shims instead.
- Before pushing, run `npm run build` and treat any TypeScript/module-resolution warning as a release blocker.

Codex will review your output once you are done
