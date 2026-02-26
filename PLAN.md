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
1. Project setup — package.json, tsconfig, vitest, eslint
2. Knex config + Postgres connection
3. All migrations (users → workspaces → groups → pages → permissions)
4. Shared types and error classes

### Phase 2: Page Hierarchy
5. Page CRUD with adjacency list
6. `page-tree.service.ts` — closure table maintenance (insert, delete, move)
7. Tests for closure table operations

### Phase 3: Groups
8. Group CRUD + membership management
9. `group-membership.service.ts` — nested group closure maintenance
10. Tests for transitive membership resolution

### Phase 4: Permission Resolution (the core)
11. `permission.types.ts` — PermissionLevel enum + comparison helpers
12. `permission.repository.ts` — the resolution CTE query
13. `permission.service.ts` — `resolvePermission(userId, pageId)`
14. `permission.middleware.ts` — `requirePagePermission(level)`
15. `permission.cache.ts` — LRU cache with invalidation
16. Exhaustive unit tests (inheritance, overrides, denial, groups, nested groups, fallback)

### Phase 5: API + Integration
17. Permission CRUD endpoints
18. Wire middleware into page routes
19. Workspace default permissions
20. Integration tests (full HTTP flows)

### Phase 6: Polish
21. Dev seed with realistic Notion-like tree
22. README with architecture docs and trade-off discussion

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

1. **Unit tests**: `npx vitest` — resolution algorithm edge cases
2. **Integration tests**: Test Postgres via Docker, full API flows
3. **Manual smoke test**: Seed data, curl to create pages, share, verify access
4. **Key scenarios**:
   - Inherited permission from grandparent resolves correctly
   - Override at child level takes precedence
   - `none` blocks inherited access
   - User-level beats group-level at same depth
   - Nested group membership grants access
   - Moving a page updates permission inheritance
   - Cache invalidates on permission change
