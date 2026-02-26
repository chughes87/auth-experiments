# CLAUDE.md

## Project Overview

Notion-inspired hierarchical document permissions system. Interview prep for Notion's Permissions team. Focus is on the authorization data model and resolution algorithm, not authentication or UI.

## Workflow

- Work in small, focused increments — each task gets its own PR
- PRs should be small and focused — one logical change per PR, targeting `main`
- Check `PLAN.md` at the start of each session to see if there is in-progress work to continue

### Starting a new task

1. **Write the plan first.** Before touching any source files, write a plan document (e.g. `MY_FEATURE_PLAN.md`) that describes what will change and why. For smaller tasks this can be a section in `PLAN.md`.
2. **Commit the plan.** Commit the plan file on its own so the intent is recorded before any code changes.
3. **Implement, then mark done.** Work through the plan, marking items `[x]` as they are completed so other agents can pick up where you left off.
4. **Large tasks: stop after the first sub-task.** If a task turns out to be large, break it into smaller sub-tasks in the plan, complete only the first sub-task, and stop — do not attempt the remaining sub-tasks.

## Tech Stack

- **Language:** TypeScript (strict mode)
- **Runtime:** Node.js
- **Framework:** Express
- **Database:** PostgreSQL with Knex (query builder + migrations)
- **Testing:** Vitest, fast-check + @fast-check/vitest (property-based testing)
- **Formal verification (nice-to-have):** TLA+ with TLC model checker

## Commands

```bash
npm install                    # Install dependencies
npm run dev                    # Start dev server
npm run build                  # TypeScript compile
npm test                       # Run vitest
npx knex migrate:latest        # Run migrations
npx knex seed:run              # Seed dev data
```

## Environment

Create a `.env` file at the repo root (never commit it):

```
DATABASE_URL="postgresql://user:password@host:5432/dbname"
```

## Key Architecture Decisions

- **Closure table + adjacency list** for page hierarchy — optimizes read-heavy permission resolution
- **Group membership closure table** for nested groups — precomputed transitive membership
- **Only explicit overrides stored** — inheritance computed at query time to avoid fan-out writes
- **Permission levels:** `none` < `read` < `write` < `full_access` (none = explicit denial)
- **Resolution precedence:** closest depth wins → user beats group → most permissive group wins

## Project Structure

```
specs/
  PermissionResolution.tla  — TLA+ specification of resolution algorithm
  PermissionResolution.cfg  — TLC model checker configuration
src/
  modules/
    users/          — User CRUD
    groups/         — Group CRUD + nested membership + closure maintenance
    pages/          — Page CRUD + closure table maintenance (page-tree.service)
    permissions/    — Resolution algorithm, middleware, cache (the core module)
  middleware/       — authenticate (simple), error-handler
  shared/           — types (branded types, discriminated unions), errors (invariant), db-utils
  config/           — database, env
  db/migrations/    — Knex migrations
  db/seeds/         — Dev seed data
tests/
  unit/             — Resolution algorithm, closure table logic
  properties/       — Property-based tests (7 properties + model-based stateful)
  snapshots/        — SQL resolution query snapshot tests
  integration/      — Full DB + API flows
```

## Critical Files

- `specs/PermissionResolution.tla` — TLA+ formal specification of resolution algorithm
- `src/modules/permissions/permission.service.ts` — Core resolution algorithm
- `src/modules/permissions/permission.repository.ts` — Resolution SQL query (CTE)
- `src/modules/pages/page-tree.service.ts` — Closure table maintenance
- `src/modules/permissions/permission.middleware.ts` — Express authorization middleware
- `tests/properties/permission.properties.test.ts` — Property-based tests for resolution invariants

## Conventions

- Module-based organization (vertical slices), not layer-based
- Repository pattern: raw SQL in `.repository.ts`, business logic in `.service.ts`
- All IDs are UUIDs
- PostgreSQL ENUM for permission_level
- Express middleware for authorization checks on page routes
- Simple auth: user ID from `X-User-Id` header (not a real auth system)
- Include tests in the same PR as the code they cover
- Use branded types for all entity IDs (`UserId`, `GroupId`, `PageId`)
- Use `invariant()` for pre/post-conditions in critical code paths
- Property-based tests go in `tests/properties/`, snapshot tests in `tests/snapshots/`

## References

- See `PLAN.md` for implementation phases and order
- See `CORRECTNESS_PLAN.md` for the five-layer correctness strategy
- See `README.md` for full architecture documentation and worked examples

## Feature Status

| Feature                          | Status      |
| -------------------------------- | ----------- |
| Project planning & documentation | Done        |
| Foundation (setup, migrations)   | In Progress |
| TLA+ specification (nice-to-have) | Not Started |
| Page hierarchy + closure table   | Not Started |
| Groups + nested membership       | Not Started |
| Permission resolution algorithm  | Not Started |
| Property-based tests             | Not Started |
| API layer + middleware           | Not Started |
| Dev seed data + polish           | Not Started |
