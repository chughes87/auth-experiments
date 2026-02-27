# Plan: Permission Resolution Repository + Service

## Context

Phase 2 of the project: implement the core permission resolution algorithm. Given a userId and pageId, determine the effective permission level by walking the page hierarchy and applying precedence rules. This is the heart of the system.

The database schema and closure tables are in place (migrations 001–006). Triggers maintain closures automatically. We need the TypeScript code that queries these tables.

Per CLAUDE.md workflow: this is a large task, so we'll complete only the first sub-task (repository + service + unit tests) and stop.

## Resolution Algorithm

```
resolvePermission(userId, pageId):
  1. Walk from pageId upward through ancestors (page_tree_closure, depth ASC)
  2. At each depth (closest first):
     a. User-level permission exists → return it
     b. Group-level permissions exist (via group_user_closure) → return most permissive
     c. First depth with any match wins
  3. No match on any ancestor → { kind: 'no_access' }
```

## Approach: Single CTE Query

One SQL round-trip does all the work:

1. **Join** `page_tree_closure` with `page_permissions` on ancestor pages
2. **Join** `group_user_closure` for group grants to filter to the user's groups
3. **Rank** by depth ASC; at min depth, user grants beat group grants; among groups, MAX wins
4. Map result to `ResolvedPermission` discriminated union

## Files to Create

### 1. `src/modules/permissions/permission.repository.ts`

```typescript
resolvePermission(conn: Knex, userId: UserId, pageId: PageId): Promise<ResolvedPermission>
```

- CTE query joining page_tree_closure → page_permissions → group_user_closure
- Returns `{ kind: 'no_access' }` when no rows match

### 2. `src/modules/permissions/permission.service.ts`

```typescript
resolvePermission(db: Knex, userId: UserId, pageId: PageId): Promise<ResolvedPermission>
```

- Delegates to repository
- Postcondition invariant: result is a valid ResolvedPermission kind

### 3. `tests/unit/permission-resolution.test.ts`

Tests against real PostgreSQL (per PLAN.md). Each test inserts data, relies on triggers for closures, then resolves:
- [x] Inherited permission from grandparent
- [x] Override at child level takes precedence
- [x] `none` blocks inherited access
- [x] User-level beats group-level at same depth
- [x] Most permissive group wins at same depth
- [x] Nested group membership grants access
- [x] No grant on any ancestor → no_access

Each test uses a transaction that rolls back for isolation.

## Files to Modify

- `PLAN.md` — mark permission.repository.ts and permission.service.ts done

## Reuse

- `ResolvedPermission`, `PageId`, `UserId`, `GroupId` from `src/shared/types.ts`
- `invariant()` from `src/shared/errors.ts`
- `db` from `src/config/database.ts`
- Triggers populate closure tables — tests just INSERT into base tables

## Verification

1. `npm run build` — compiles
2. `npm test` — all unit tests pass
