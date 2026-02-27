# Plan: Move Closure Table Maintenance from Triggers to Application Code

## Context

Closure tables (`page_tree_closure`, `group_group_closure`, `group_user_closure`) are currently maintained by PostgreSQL triggers and PL/pgSQL functions defined in migrations 005 and 006. We want to move this logic to application-level TypeScript for better readability, testability, and debuggability. Database transactions provide sufficient consistency guarantees.

The cycle prevention trigger (migration 005) also needs to move since it depends on `group_group_closure` being maintained by the application.

## Why

- **Testability:** Unit-testable TypeScript vs requiring a real Postgres instance to exercise PL/pgSQL
- **Debuggability:** Standard Node.js debugging instead of opaque trigger failures
- **Readability:** All logic in one language, visible in the service layer
- **Sufficient consistency:** Wrapping operations in transactions prevents inconsistent state; we don't need trigger-level guarantees for this use case

## Approach

### Step 1: New migration to drop all triggers

Create `007_drop_closure_triggers.ts` that drops:
- `trg_page_tree_insert` + `maintain_page_tree_insert()`
- `trg_group_ancestor_insert` + `maintain_group_ancestor_insert()`
- `trg_group_membership_insert` + `maintain_group_membership_insert()`
- `trg_group_membership_delete` + `maintain_group_membership_delete()`
- `trg_prevent_group_cycle` + `prevent_group_cycle()`

The `down()` migration restores the triggers (copied from 005/006).

### Step 2: Page tree closure — application-level

**`src/modules/pages/page-tree.repository.ts`** — raw SQL queries:
- `insertClosureEntries(trx, pageId, parentId)` — self-ref row (depth 0) + ancestor rows
- `deleteClosureSubtree(trx, pageId)` — for moves/deletes
- `reinsertClosureSubtree(trx, pageId, newParentId)` — for moves

**`src/modules/pages/page-tree.service.ts`** — business logic:
- `onPageCreated(trx, pageId, parentId)` — insert closure entries
- `onPageMoved(trx, pageId, newParentId)` — delete old paths + reinsert for subtree
- `onPageDeleted(trx, pageId)` — explicit cleanup (or rely on FK cascade)

### Step 3: Group closure — application-level

**`src/modules/groups/group-closure.repository.ts`** — raw SQL queries:
- `insertGroupGroupEntries(trx, parentGroupId, childGroupId)` — self-refs + direct + transitive
- `insertGroupUserEntries(trx, groupId, userId)` — user membership propagation to ancestors
- `insertGroupNestingUserEntries(trx, parentGroupId, childGroupId)` — user cascade on nesting
- `rebuildUserClosureForUser(trx, userId)` — delete + re-derive (for user removal)
- `rebuildUserClosureForGroup(trx, groupId)` — delete + re-derive (for group unnesting)
- `checkGroupCycle(trx, parentGroupId, childGroupId)` — returns boolean

**`src/modules/groups/group-membership.service.ts`** — business logic:
- `addUserToGroup(trx, groupId, userId)` — insert `group_members` row + update closures
- `removeUserFromGroup(trx, groupId, userId)` — delete row + rebuild user closure
- `nestGroup(trx, parentGroupId, childGroupId)` — cycle check + insert + update both closures
- `unnestGroup(trx, parentGroupId, childGroupId)` — delete + rebuild closures

## Implementation notes

- SQL logic translates directly from the PL/pgSQL in migration 006 — same queries, executed via Knex `raw()` in TypeScript
- Reuse `withTransaction()` from `src/shared/db-utils.ts`
- Reuse branded types (`PageId`, `GroupId`, `UserId`) from `src/shared/types.ts`
- Reuse `invariant()` from `src/shared/errors.ts` for pre/post-conditions
- Split across two PRs: page-tree first, then group closures

## Verification

1. `npm run build` passes
2. `npx knex migrate:latest` applies migration 007
3. Confirm triggers are gone: `\df` in psql
4. `npm test` passes
