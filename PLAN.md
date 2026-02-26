# Notion-like Hierarchical Document Permissions System

## Context

Building a workspace permission system modeled after Notion's architecture to prepare for a Permissions team onsite interview. The system tackles the core challenges from the job posting: granular permission models, team/group hierarchies, permission inheritance, and performant access resolution.

**Stack:** TypeScript, Node.js (Express), PostgreSQL, Knex (query builder + migrations), Vitest (tests)

---

## Database Schema

### Hierarchy strategy: Closure Table + Adjacency List

Permission checks happen on every page load (reads dominate 100:1 over writes). A closure table precomputes ancestor/descendant relationships so permission resolution is a single JOIN query — no recursive CTEs needed at read time. The adjacency list (`parent_id`) stays for natural tree operations.

### Tables

- **users** — id, email, name
- **workspaces** — id, name, owner_id
- **workspace_members** — workspace_id, user_id, role (owner/admin/member/guest)
- **groups** — id, workspace_id, name
- **group_members** — group_id, user_id OR child_group_id (nested groups)
- **group_membership_closure** — ancestor_group_id, descendant_user_id, depth (precomputed transitive membership)
- **pages** — id, workspace_id, parent_id, title, content, created_by
- **page_tree_paths** — ancestor_id, descendant_id, depth (closure table)
- **page_permissions** — page_id, user_id OR group_id, permission (none/read/write/full_access)
- **workspace_default_permissions** — workspace_id, user_id OR group_id, permission (fallback)

---

## Permission Resolution Algorithm

Given `(userId, pageId)`, resolve effective access in **one SQL query**:

1. CTE `user_groups`: all group IDs the user belongs to (via `group_membership_closure`)
2. CTE `ancestors`: all ancestors of the page ordered by depth ASC (via `page_tree_paths`)
3. JOIN `page_permissions` to find the closest override, preferring:
   - **Depth**: closer to target page wins (depth 0 = page itself)
   - **Grantee type at same depth**: direct user grant beats group grant
   - **Multiple groups at same depth**: most permissive wins
4. Fallback to `workspace_default_permissions` if no page-level match
5. Default to `none` if nothing found

Key behaviors:
- `none` is an explicit denial (blocks inherited access — like Notion's "Remove access")
- Only explicit overrides are stored; inheritance is computed at query time
- Changing a parent's permission instantly affects all descendants without fan-out writes

---

## Project Structure

```
src/
  index.ts                          # Server bootstrap
  app.ts                            # Express setup + middleware
  config/
    database.ts                     # Postgres pool (Knex)
    env.ts                          # Env validation
  db/
    migrations/                     # Knex migrations (001-005)
    seeds/
      dev-seed.ts                   # Realistic test data
  modules/
    users/         (router, controller, service, repository)
    workspaces/    (router, controller, service, repository)
    groups/        (router, controller, service, repository, group-membership.service)
    pages/         (router, controller, service, repository, page-tree.service)
    permissions/   (router, controller, service, repository, middleware, cache, types)
  middleware/
    authenticate.ts                 # Simple user-id-from-header (not a full auth system)
    error-handler.ts
  shared/
    types.ts, errors.ts, db-utils.ts
tests/
  unit/permissions/                 # Resolution algorithm tests (mocked repo)
  unit/pages/                       # Closure table logic tests
  integration/permissions/          # Full DB scenarios
  fixtures/test-data.ts
```

---

## API Endpoints

```
POST   /api/users
POST   /api/workspaces
POST   /api/workspaces/:wsId/members
POST   /api/groups
POST   /api/groups/:groupId/members

POST   /api/workspaces/:wsId/pages         # Top-level page
POST   /api/pages/:pageId/children          # Child page
GET    /api/pages/:pageId                   # Requires read
PATCH  /api/pages/:pageId                   # Requires write
DELETE /api/pages/:pageId                   # Requires full_access
PATCH  /api/pages/:pageId/move              # Reparent

GET    /api/pages/:pageId/permissions       # List explicit permissions
POST   /api/pages/:pageId/permissions       # Share (set permission)
DELETE /api/pages/:pageId/permissions/:id   # Unshare
GET    /api/pages/:pageId/effective-access  # Current user's resolved access
```

Authorization middleware (`requirePagePermission('read')`) wraps page endpoints.

---

## Implementation Order

### Phase 1: Foundation
1. Project setup — package.json, tsconfig, vitest, eslint, fast-check
2. Knex config + Postgres connection
3. All migrations (users → workspaces → groups → pages → permissions)
4. Shared types (branded types for IDs, discriminated unions) and error classes (`invariant()` function)

### Phase 2: TLA+ Specification
5. Model permission resolution as a pure TLA+ operator
6. Define invariants (denial supremacy, depth monotonicity, cycle safety, move safety)
7. Run TLC model checker against small model, fix any violations

### Phase 3: Page Hierarchy
8. Page CRUD with adjacency list
9. `page-tree.service.ts` — closure table maintenance (insert, delete, move)
10. Unit tests + property-based tests for closure table operations

### Phase 4: Groups
11. Group CRUD + membership management
12. `group-membership.service.ts` — nested group closure maintenance
13. Cycle prevention trigger migration
14. Tests for transitive membership resolution

### Phase 5: Permission Resolution (the core)
15. `permission.types.ts` — PermissionLevel enum + comparison helpers
16. `permission.repository.ts` — the resolution CTE query
17. `permission.service.ts` — `resolvePermission(userId, pageId)` with runtime invariants
18. `permission.middleware.ts` — `requirePagePermission(level)`
19. `permission.cache.ts` — LRU cache with invalidation
20. Unit tests (inheritance, overrides, denial, groups, nested groups, fallback)
21. Property-based tests (7 properties + model-based stateful testing)
22. Snapshot tests for the resolution SQL query

### Phase 6: API + Integration
23. Permission CRUD endpoints
24. Wire middleware into page routes
25. Workspace default permissions
26. Integration tests (full HTTP flows)

### Phase 7: Polish
27. Dev seed with realistic Notion-like tree
28. Update README with final documentation

---

## Key Trade-offs

| Decision | Trade-off | Rationale |
|---|---|---|
| Closure table vs recursive CTE | More write overhead, faster reads | Reads dominate 100:1 |
| Store only explicit overrides | Resolution requires ancestor walk | Avoids fan-out writes when parent permission changes |
| User permission > group at same depth | Could surprise in edge cases | Matches Notion; explicit personal overrides feel intentional |
| LRU cache | Stale data risk | TTL + event-driven invalidation; production would use Redis |
| PostgreSQL ENUM for permission_level | Harder to add levels later | Type-safe; `ALTER TYPE ADD VALUE` if needed |

---

## Verification

Five layers of correctness verification — see `CORRECTNESS_PLAN.md` for full details.

1. **TLA+ model checking**: `tlc specs/PermissionResolution.tla` — verify resolution invariants hold across all reachable states
2. **Type-level**: Branded types and discriminated unions catch ID mixups and unhandled states at compile time
3. **Property-based tests**: `npx vitest tests/properties/` — 7 properties + model-based stateful testing across random trees and op sequences
4. **Unit tests**: `npx vitest tests/unit/` — resolution algorithm edge cases
5. **Integration tests**: Test Postgres via Docker, full API flows
6. **Snapshot tests**: Resolution SQL query locked down against known-good fixtures
7. **Manual smoke test**: Seed data, curl to create pages, share, verify access
8. **Key scenarios**:
   - Inherited permission from grandparent resolves correctly
   - Override at child level takes precedence
   - `none` blocks inherited access
   - User-level beats group-level at same depth
   - Nested group membership grants access
   - Moving a page updates permission inheritance
   - Cache invalidates on permission change
