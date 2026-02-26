# Revised Plan: Hierarchical Document Permissions System

## Context

Restructured plan that is **resolver-first** — build the core algorithm first, validate it, then wrap in API infrastructure.

## Schema Fixes from Original Plan

1. **Split group closure into two concerns**: `group_ancestor_paths` (group→group nesting) + `group_membership_closure` (flattened user→group, derived)
2. **Simplify workspace defaults**: Single `default_permission` column on `workspaces` instead of separate table
3. **Explicit `full_access` requirement**: Permission management requires `full_access` on the page

---

## Implementation Order

### Phase 1: Minimal Foundation [Done]
- [x] Project setup: package.json, tsconfig (strict), vitest, fast-check, knex, express
- [x] Env config + Knex Postgres connection
- [x] Shared types: branded IDs, PermissionLevel enum, ResolvedPermission, invariant()
- [x] All migrations in order:
  1. users
  2. workspaces + workspace_members
  3. groups + group_members + group_ancestor_paths + group_membership_closure
  4. pages + page_tree_paths
  5. page_permissions
  6. cycle prevention trigger (checks group_ancestor_paths)
  7. closure table maintenance triggers (page_tree_paths, group closures)

**Deliverable:** `npm run build` passes, `npx knex migrate:latest` creates all tables.

### Phase 2: Resolution Algorithm + Core Services [Not Started]
- [ ] `permission.repository.ts` — the resolution CTE query
- [ ] `permission.service.ts` — `resolvePermission(userId, pageId)` with runtime invariants
- [ ] `page-tree.service.ts` — closure table maintenance (insert, delete, move)
- [ ] `group-membership.service.ts` — group nesting closure maintenance, cycle check
- [ ] Unit tests for the resolver against a real DB:
  - Inherited permission from grandparent
  - Override at child level takes precedence
  - `none` blocks inherited access
  - User-level beats group-level at same depth
  - Most permissive group wins at same depth
  - Nested group membership grants access
  - Workspace default fallback
  - Moving a page updates inheritance
- [ ] Snapshot test for the resolution SQL query

**Deliverable:** The resolver works end-to-end against Postgres. Core algorithm is proven correct.

### Phase 3: Property-Based Tests [Not Started]
- [ ] Custom arbitraries: `arbPageTree`, `arbPermissions`, `arbMembershipGraph`
- [ ] In-memory oracle (`permission.model.ts`) — simple recursive resolution
- [ ] Seven property tests:
  1. Determinism
  2. Depth monotonicity
  3. Denial supremacy
  4. Idempotency
  5. Group monotonicity
  6. Inheritance correctness
  7. Move correctness
- [ ] Model-based stateful testing (stretch goal)

**Deliverable:** `npm test` runs property tests against real DB + oracle.

### Phase 4: API Layer [Not Started]
- [ ] `authenticate` middleware (X-User-Id header)
- [ ] `requirePagePermission(level)` middleware
- [ ] Page CRUD routes (create, get, update, delete, move)
- [ ] Permission management routes (list, share, unshare, effective-access)
  - Share/unshare requires `full_access`
- [ ] Minimal user/workspace/group CRUD (just enough for test scenarios)
- [ ] Integration tests: full HTTP flows

**Deliverable:** Curl-able API that demonstrates the full permission system.

### Phase 5: Polish [Not Started]
- [ ] Dev seed data with realistic Notion-like tree
- [ ] LRU cache with honest invalidation (full flush on any mutation)
- [ ] Update docs with final state

### Stretch: TLA+ Specification [Not Started]
- [ ] Model resolution as a pure TLA+ operator
- [ ] Define invariants, run TLC against small model

---

## Key Design Decisions

| Decision | Resolution |
|---|---|
| User-over-group at same depth | Direct user grant overrides group grants. Intentional — "direct grants are deliberate overrides." |
| Cache invalidation | Full cache flush on mutations. Simple and correct. |
| Workspace defaults | Single `default_permission` on `workspaces` table. |
| Permission management access | Requires `full_access` on the page. Enforced by middleware. |

---

## Verification

- Phase 1: `npm run build` + `npx knex migrate:latest` succeed
- Phase 2: `npm test` — unit tests pass against real Postgres
- Phase 3: `npm test` — property tests pass
- Phase 4: `npm test` — integration tests pass; manual curl smoke test
- Phase 5: `npx knex seed:run` + curl walkthrough
