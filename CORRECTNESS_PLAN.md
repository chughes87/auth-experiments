# Correctness Strategy

A permissions bug means either data leaks (users see what they shouldn't) or lockouts (users can't access what they should). Both are unacceptable. This document describes five layers of defense, each catching different classes of bugs that the others miss.

## Summary

| Layer | What it catches | Cost |
|---|---|---|
| TLA+ specification | Logic errors in the resolution algorithm design | 1-2 days (resolution only) |
| TypeScript type encoding | ID mixups, unhandled permission states | 1-2 hours setup, then free |
| Property-based testing | Edge cases in random tree shapes, group hierarchies, op sequences | 1-2 days for properties + model |
| Database constraints | Cycle corruption, orphaned records, invalid states from concurrent writes | 2-3 hours in migrations |
| Runtime invariants + snapshots | Regressions, contract violations between layers | 1-2 hours |

---

## Layer 1: TLA+ Specification

Formally model the permission resolution algorithm and verify invariants with the TLC model checker *before* writing implementation code. This catches design errors — cases where the algorithm itself produces the wrong answer, regardless of implementation quality.

### What to model

The resolution algorithm as a **pure TLA+ operator**: given a set of users, groups, pages (tree), and permission assignments, compute the effective access for any (user, page) pair.

```
ResolvePermission(user, page) ==
    Walk ancestors from page upward.
    At each depth: check user-level grants, then group-level grants.
    First match wins (closest depth, user over group, most permissive group).
    Fallback to workspace default, then 'none'.
```

### Invariants to verify

1. **Denial supremacy**: If `none` is explicitly set at depth D for a user, and no closer override (depth < D) exists, the resolved permission is `none`.

2. **Depth monotonicity**: If overrides exist at depths D1 and D2 where D1 < D2, the override at D1 determines the result regardless of D2's value.

3. **User-over-group precedence**: If both a user grant and a group grant exist at the same depth, the user grant wins.

4. **No cycle escalation**: Adding a cycle in group nesting (A contains B, B contains A) does not grant any user more access than they would have without the cycle.

5. **Determinism**: The resolution operator is a pure function — same inputs always produce the same output. (This is guaranteed by construction if defined without non-determinism in TLA+.)

6. **Move safety**: After reparenting a page, all resolution invariants still hold for every descendant.

### Model size

Small model is sufficient — resolution bugs surface with small inputs:
- 2-3 users, 2 groups, 3-4 pages (depth 2-3)
- TLC exhaustively checks all reachable states in minutes

### Files

```
specs/
  PermissionResolution.tla    # TLA+ specification
  PermissionResolution.cfg    # TLC model checker configuration
```

### Scope boundary

Model the resolution algorithm only. Do **not** model:
- SQL query correctness (abstraction gap — TLA+ models the algorithm, not the SQL)
- Cache behavior (implementation detail)
- HTTP/API layer
- Performance characteristics

---

## Layer 2: TypeScript Type-Level Encoding

Shift entire categories of bugs to compile time with zero runtime cost.

### Branded types for IDs

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };

type UserId = Brand<string, 'UserId'>;
type GroupId = Brand<string, 'GroupId'>;
type PageId = Brand<string, 'PageId'>;
type WorkspaceId = Brand<string, 'WorkspaceId'>;
```

This prevents accidentally passing a `GroupId` where a `PageId` is expected. The compiler catches it; no test needed.

### Discriminated unions for resolution results

```typescript
type ResolvedPermission =
  | { kind: 'direct'; level: PermissionLevel; pageId: PageId }
  | { kind: 'inherited'; level: PermissionLevel; fromPageId: PageId; depth: number }
  | { kind: 'workspace_default'; level: PermissionLevel }
  | { kind: 'no_access' };
```

The compiler forces exhaustive handling everywhere a resolution result is consumed. Adding a new variant is a compile error until all consumers are updated.

### `invariant()` with `asserts` return type

```typescript
function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}
```

After calling `invariant(x !== null, '...')`, TypeScript narrows `x` to non-null. Bridges runtime checking and the type system.

### Files

- `src/shared/types.ts` — branded types, discriminated unions
- `src/shared/errors.ts` — `invariant()` function, `InvariantViolation` error class

---

## Layer 3: Property-Based Testing with fast-check

Unit tests verify specific known scenarios. Property-based tests verify *invariants* hold across thousands of randomly generated scenarios — catching edge cases you didn't think to write tests for.

### Dependencies

```bash
npm install --save-dev fast-check @fast-check/vitest
```

### Seven properties

**Property 1: Determinism**
Same `(userId, pageId)` always resolves to the same permission level.

**Property 2: Depth monotonicity**
If overrides exist at two different ancestor depths, the closer one always wins regardless of tree shape, number of branches, or other permission assignments.

**Property 3: Denial supremacy**
If `none` is set at any ancestor and no closer override exists, the result is `none`. This is the most security-critical property.

**Property 4: Idempotency**
Setting the same permission twice does not change the resolved outcome.

**Property 5: Group monotonicity**
Adding a user to a group never reduces their effective access to any page. (This follows from "most permissive group wins at same depth".)

**Property 6: Inheritance correctness**
If no override exists on the path from a page to the root, the closest ancestor's permission propagates unchanged.

**Property 7: Move correctness**
After reparenting a page, permissions resolve based on the new ancestor chain, not the old one. This tests closure table maintenance.

### Model-based stateful testing (the highest-value technique)

Use `fc.commands()` to generate random sequences of operations:
- Create page (with random parent)
- Move page (random reparent)
- Set permission (random user/group, random level, random page)
- Add user to group
- Resolve permission (random user, random page)

Each operation executes against both the **real system** (Postgres + closure tables + cache) and a **simplified in-memory oracle** (direct recursive resolution). After every operation, assert that the real system and the oracle agree.

When fast-check finds a discrepancy, it **shrinks** to the minimal sequence of operations that reproduces the bug.

### Custom arbitraries

```typescript
// Random page tree (controlled depth and breadth)
function arbPageTree(maxDepth = 4, maxBreadth = 5): fc.Arbitrary<PageNode>

// Random permission assignments over a given set of pages/users/groups
function arbPermissions(pageIds, userIds, groupIds): fc.Arbitrary<PermissionAssignment[]>

// Random group membership graph (acyclic)
function arbMembershipGraph(userIds, groupIds): fc.Arbitrary<GroupMembership[]>
```

### Files

```
tests/
  properties/
    permission.properties.test.ts   # Seven property tests
    stateful.test.ts                # Model-based stateful testing
    arbitraries.ts                  # Custom generators
    permission.model.ts             # In-memory oracle for model-based testing
```

---

## Layer 4: Database-Level Constraints

Even if application code has a bug, the database rejects invalid states. This is defense in depth — multiple application codepaths, direct SQL access, and concurrent writes are all covered.

### Cycle prevention trigger

The most important database-level invariant. If adding a group membership edge would create a cycle (A contains B, B contains A), the insert is rejected.

```sql
CREATE OR REPLACE FUNCTION prevent_group_cycle()
RETURNS TRIGGER AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM group_membership_closure
    WHERE ancestor_group_id = NEW.child_group_id
      AND descendant_user_id IN (
        SELECT descendant_user_id FROM group_membership_closure
        WHERE ancestor_group_id = NEW.group_id
      )
  ) THEN
    RAISE EXCEPTION 'Cycle detected: would create circular group nesting';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

### Closure table integrity

Triggers that maintain `page_tree_paths` on page insert/delete/move and `group_membership_closure` on group membership changes. These ensure the precomputed closure tables never drift from the source of truth (adjacency list / group_members).

### Standard constraints

- Foreign keys on every ID column with appropriate `ON DELETE` behavior
- `UNIQUE(page_id, user_id)` and `UNIQUE(page_id, group_id)` on `page_permissions` — at most one grant per grantee per page
- `CHECK` constraint ensuring exactly one of `user_id` or `group_id` is non-null on permission grants
- PostgreSQL `ENUM` for permission_level — invalid values rejected at the type level

### Files

- `src/db/migrations/006_create_cycle_prevention_trigger.ts`
- `src/db/migrations/007_create_closure_triggers.ts`

---

## Layer 5: Runtime Invariant Assertions + Snapshot Tests

### Strategic invariant placement

```typescript
// In the permission resolver — post-condition
function resolvePermission(userId: UserId, pageId: PageId): ResolvedPermission {
  const result = doResolve(userId, pageId);

  // The resolved permission must be one of the valid levels
  invariant(
    isValidPermissionLevel(result.level),
    `Invalid resolved permission: ${result.level}`
  );

  return result;
}

// In closure table maintenance — post-condition after move
async function movePage(pageId: PageId, newParentId: PageId): Promise<void> {
  await doMove(pageId, newParentId);

  // Verify closure table consistency
  if (process.env.NODE_ENV !== 'production') {
    const isConsistent = await verifyClosureTableConsistency(pageId);
    invariant(isConsistent, `Closure table inconsistent after moving page ${pageId}`);
  }
}
```

### Snapshot tests for the SQL resolution query

Lock down the resolution CTE query's output against known-good fixtures. Run the exact SQL against a deterministic seed and compare to a committed snapshot.

```typescript
it('resolves the standard fixture correctly', async () => {
  await seedStandardFixture(db);
  const results = await db.raw(RESOLVE_PERMISSION_SQL, [userId, pageId]);
  expect(results.rows).toMatchSnapshot();
});
```

Any change to the query or schema that affects resolution results requires explicitly approving the new snapshot — forcing a human review of correctness implications.

### Files

- `src/shared/errors.ts` — `invariant()` function
- `tests/snapshots/resolution-query.test.ts`

---

## What Each Layer Cannot Catch

Understanding the gaps is as important as understanding the coverage:

| Layer | Cannot catch |
|---|---|
| TLA+ | SQL bugs, cache issues, implementation bugs (model ≠ code) |
| Type encoding | Logic errors where types are correct but values are wrong |
| Property-based testing | Properties you didn't think to write, issues only at scale |
| Database constraints | Application-level logic errors that produce valid-but-wrong data |
| Runtime invariants | Bugs in the invariant checks themselves, performance issues |

This is why all five layers are needed. No single technique is sufficient.

---

## Implementation Order

1. **Phase 1 (Foundation):** Set up branded types, `invariant()` function, install fast-check
2. **Phase 2 (TLA+):** Write and verify the TLA+ spec before implementing the resolver
3. **Phase 3-4 (Hierarchy + Groups):** Add cycle prevention trigger, property tests for closure tables
4. **Phase 5 (Permission Resolution):** Implement resolver with runtime invariants, add 7 property tests + model-based tests + snapshot tests
5. **Phase 6 (Integration):** Full-stack integration tests verify all layers work together
