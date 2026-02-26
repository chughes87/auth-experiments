# Hierarchical Document Permissions System

A Notion-inspired permission system that implements granular access control over a hierarchical page tree. Built to explore the real engineering challenges behind workspace permissions: inheritance, overrides, group hierarchies, and performant resolution.

## Architecture Overview

### The Problem

In a document workspace like Notion, pages are organized as trees. A workspace might look like:

```
Workspace: Acme Corp
├── Engineering
│   ├── Roadmap            ← shared with all of Engineering
│   │   ├── Q1 Goals
│   │   └── Q2 Goals       ← restricted to leadership only
│   └── Onboarding Guide
├── Marketing
│   ├── Brand Guidelines
│   └── Campaign Plans     ← shared with specific external partners
└── Company Wiki
    ├── Benefits
    └── Org Chart
```

Users expect permissions to "just work" intuitively:
- Share "Engineering" with the engineering team → everyone can access everything underneath
- Restrict "Q2 Goals" to leadership → overrides the inherited access
- Remove someone's access to a specific child page → explicit denial

This creates a surprisingly complex resolution problem: for any given (user, page) pair, the system must determine the effective access level by considering direct grants, group memberships (potentially nested), inherited permissions from ancestor pages, explicit overrides, and workspace-level defaults — all while remaining fast enough to run on every single page load.

### Core Concepts

#### Permission Levels

Four levels, ordered by privilege:

| Level | Meaning |
|---|---|
| `none` | Explicit denial — blocks any inherited access |
| `read` | Can view the page and its content |
| `write` | Can view and edit the page |
| `full_access` | Can view, edit, delete, and manage permissions |

`none` is not simply "no permission set." It is an active denial. This distinction matters: a page with no permission entries inherits from its parent, while a page with an explicit `none` grant blocks inheritance for that user/group. This models Notion's "Remove access" behavior on shared pages.

#### Permission Inheritance

Permissions flow downward through the page tree. If a user has `write` access on a parent page and no explicit permission is set on a child page, the child inherits `write`. This continues recursively to arbitrary depth.

```
Page A (user has write)
└── Page B (no explicit permission → inherits write)
    └── Page C (no explicit permission → inherits write)
        └── Page D (user has read → override, effective = read)
            └── Page E (no explicit permission → inherits read from D)
```

Inheritance stops at the nearest explicit override. In the example above, Page D's `read` override means Page E inherits `read` from D, not `write` from A.

#### Grantee Types

Permissions can be granted to:

1. **Individual users** — a direct grant to a specific person
2. **Groups** — a grant to a named set of users (e.g., "Engineering Team")
3. **Nested groups** — groups can contain other groups, creating hierarchies like "All Engineers" → "Backend Team" → individual engineers

When multiple grants apply at the same page level, resolution follows precedence rules (detailed below).

---

## Permission Resolution

The resolution algorithm is the heart of the system. Given a `userId` and `pageId`, it determines the effective `PermissionLevel`.

### Algorithm

```
resolvePermission(userId, pageId):
    1. Collect all groups the user belongs to (including via nested groups)
    2. Walk from the target page upward through all ancestors
    3. At each level (starting from the page itself):
       a. Look for an explicit user-level permission → if found, return it
       b. Look for group-level permissions → if found, take the most permissive
       c. If any match found at this depth, return it (closest override wins)
    4. If no match found on any page, check workspace defaults
    5. If still nothing, return 'none'
```

### Precedence Rules

These rules determine which permission wins when multiple grants could apply:

1. **Depth (closest wins):** A permission set directly on the target page takes precedence over one set on its parent, which takes precedence over grandparent, and so on. This is the most important rule — it makes overrides work.

2. **User over group (at same depth):** If both a direct user grant and a group grant exist on the same page, the user grant wins. Rationale: a direct grant to a specific person represents a deliberate, targeted decision that should override broader group settings.

3. **Most permissive group (at same depth):** If a user belongs to multiple groups that all have grants on the same page, the most permissive grant wins. If Group A grants `read` and Group B grants `write`, the user gets `write`. This prevents the confusing situation where adding someone to an additional group *reduces* their access.

4. **Workspace default (fallback):** If no explicit permission exists on any ancestor page, the workspace-level default applies. This is how you give all workspace members baseline `read` access.

5. **None (default):** If absolutely nothing matches, the user has no access.

### Example Walkthrough

```
Workspace default: all members get 'read'

Page: Engineering       → Group "Eng Team" has 'write'
  Page: Roadmap         → (no explicit permissions)
    Page: Q2 Goals      → Group "Leadership" has 'full_access'
                         → User "alice" has 'none'
```

**Resolving access for Bob (member of Eng Team, not in Leadership) on Q2 Goals:**
1. Check Q2 Goals (depth 0): No user grant for Bob. No group grant for Bob's groups. No match.
2. Check Roadmap (depth 1): No permissions at all. No match.
3. Check Engineering (depth 2): Group "Eng Team" has `write`. Bob is in Eng Team. Match → `write`.

**Resolving access for Carol (member of both Eng Team and Leadership) on Q2 Goals:**
1. Check Q2 Goals (depth 0): No user grant. Group grants: Leadership → `full_access`, Eng Team is not directly on this page. Match → `full_access`.

**Resolving access for Alice (member of Eng Team) on Q2 Goals:**
1. Check Q2 Goals (depth 0): User grant for Alice → `none`. Match → `none`. Alice is explicitly denied, even though she'd inherit `write` from the Eng Team grant on the Engineering page.

---

## Data Model

### Hierarchy: Closure Table + Adjacency List

The page hierarchy uses two complementary representations:

**Adjacency list** (`pages.parent_id`): The natural representation. Each page points to its parent. Simple for inserts, intuitive for tree display, but resolving "all ancestors of page X" requires a recursive query.

**Closure table** (`page_tree_paths`): A precomputed table of all ancestor-descendant relationships. For a page at depth 3, the closure table contains entries connecting it to itself (depth 0), its parent (depth 1), its grandparent (depth 2), and the root (depth 3).

```
page_tree_paths:
  ancestor_id | descendant_id | depth
  ────────────┼───────────────┼──────
  A           | A             | 0      ← self
  A           | B             | 1      ← A is parent of B
  A           | C             | 2      ← A is grandparent of C
  B           | B             | 0      ← self
  B           | C             | 1      ← B is parent of C
  C           | C             | 0      ← self
```

**Why both?** The adjacency list is natural for tree display and simple operations. The closure table enables the permission resolution query to find all ancestors in a single JOIN — no recursive CTE needed at query time. Since permission checks happen on every page load and structural changes (creating, moving pages) are comparatively rare, optimizing read performance is the right trade-off.

**Cost:** Inserting a page at depth N requires inserting N+1 rows into the closure table. Moving a subtree requires deleting and reinserting paths for every descendant. This is acceptable because moves are rare and bounded by subtree size.

### Group Membership Closure

The same closure table pattern applies to group membership. If Group A contains Group B which contains User X, the `group_membership_closure` table has a row connecting Group A to User X. This allows the permission resolution query to find all of a user's groups (including indirect membership) in a single query.

### Why Not Materialize Inherited Permissions?

An alternative design would store the effective (resolved) permission for every (user, page) pair, updated whenever anything changes. This would make reads trivial (`SELECT permission WHERE user_id = ? AND page_id = ?`) but creates a massive fan-out problem on writes:

- Changing a permission on a page with 10,000 descendants requires updating rows for every descendant × every affected user
- Adding a user to a group requires computing and storing permissions for every page that group has access to
- Moving a subtree requires recomputing the entire subtree

By storing only explicit overrides and computing inheritance at query time (with the closure table making this efficient), writes remain simple and bounded. The trade-off is a slightly more complex read query, which is mitigated by caching.

---

## Caching Strategy

Permission resolution hits the database with a moderately complex query. For production workloads, this needs caching.

### Approach: LRU Cache with Event-Driven Invalidation

```
Cache key:   perm:{userId}:{pageId}
Cache value: PermissionLevel
TTL:         5 minutes (safety net)
```

**Invalidation triggers:**
- Permission created/updated/deleted on any page → invalidate all cache entries for that page and its descendants
- User added/removed from a group → invalidate all cache entries for that user
- Page moved (reparented) → invalidate all cache entries for the moved subtree
- Workspace default changed → invalidate all cache entries for the workspace

For this project, the cache is an in-memory LRU (using the `lru-cache` package). In production, this would be Redis with pub/sub for cross-instance invalidation.

---

## API Design

All page endpoints are protected by authorization middleware that calls the permission resolver:

```typescript
// Middleware pattern
router.get('/api/pages/:pageId',
    authenticate,                    // Extract user from request
    requirePagePermission('read'),   // Resolve and check permission
    pageController.getPage           // Handle request
);
```

The `authenticate` middleware is deliberately simple (extracts a user ID from a header) — this project is about authorization, not authentication.

### Permission Management Endpoints

```
GET  /api/pages/:pageId/permissions      → List explicit grants on this page
POST /api/pages/:pageId/permissions      → Share: grant access to user or group
     Body: { "userId": "..." | "groupId": "...", "permission": "read|write|full_access|none" }
DELETE /api/pages/:pageId/permissions/:id → Remove an explicit grant (reverts to inheritance)
GET  /api/pages/:pageId/effective-access → Resolve the calling user's effective access
```

The distinction between DELETE (remove grant, revert to inheritance) and POST with `none` (explicitly deny) is important and mirrors Notion's UX.

---

## Technology Choices

| Technology | Role | Why |
|---|---|---|
| TypeScript | Language | Type safety for permission levels and complex data structures; matches Notion's stack |
| Express | HTTP framework | Minimal, well-understood; middleware pattern fits authorization cleanly |
| PostgreSQL | Database | ENUMs for permission levels, strong constraint support, CTEs for complex queries |
| Knex | Query builder | Raw SQL control for the resolution query, structured migrations |
| Vitest | Testing | Fast, TypeScript-native, good assertion library |

---

## What This Project Deliberately Skips

- **Authentication:** Users are identified by a header. No JWT, OAuth, or session management.
- **Rich content:** Pages have a `title` and `content: TEXT`. No block-level editing.
- **Real-time:** No WebSocket collaboration or live permission updates.
- **UI:** API-only. The interesting work is in the data model and resolution algorithm.
- **Multi-tenancy at scale:** Single Postgres instance. Production would shard by workspace.
