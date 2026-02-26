# Permission Resolution Specification

Formal specification of the permission resolution algorithm. This document is the single source of truth for how `resolvePermission(userId, pageId)` behaves.

---

## 1. Definitions

**Permission levels**, ordered by privilege:

```
none < read < write < full_access
```

- `none` is an *explicit denial*, not the absence of a grant.
- Removing a grant (DELETE) reverts to inheritance. Setting `none` (POST) actively blocks it.

**Grantee types:**

| Type | Meaning |
|------|---------|
| User grant | Permission assigned directly to a specific user on a specific page |
| Group grant | Permission assigned to a group on a specific page; applies to all transitive members |

**Depth:** The number of edges between the target page and the page where a grant exists. Depth 0 = the target page itself. Depth 1 = parent. Depth N = N levels up.

**Ancestor chain:** The ordered sequence `[page, parent, grandparent, ..., root]` derived from the closure table.

**Effective groups:** All groups a user belongs to, including indirect membership through nested groups. Computed from `group_membership_closure`.

---

## 2. Precedence Rules

Four rules, applied in strict order. Each rule is a tiebreaker for the previous one.

### Rule 1: Closest depth wins

Given two applicable grants at depths D1 and D2 where D1 < D2, the grant at D1 always wins regardless of permission level, grantee type, or any other factor.

> This is what makes overrides work. A `read` at depth 0 beats a `full_access` at depth 1.

### Rule 2: User grant beats group grant (at same depth)

If both a direct user grant and one or more group grants exist at the same depth, the user grant wins. Group grants at that depth are ignored entirely.

> Rationale: a direct grant to a named individual is a deliberate, targeted decision.

### Rule 3: Most permissive group wins (at same depth)

If multiple group grants apply at the same depth (and no user grant exists at that depth), take the maximum permission level across all applicable groups.

> This prevents the paradox where adding a user to an additional group *reduces* their access.

### Rule 4: Workspace default as fallback

If no grant is found on any page in the ancestor chain, apply the workspace's `default_permission`. If no workspace default is set, the result is `none`.

---

## 3. Algorithm (Pseudocode)

```
function resolvePermission(userId, pageId) -> PermissionLevel:
    groups ← effectiveGroups(userId)          // all transitive group memberships
    ancestors ← ancestorChain(pageId)         // [(pageId, 0), (parentId, 1), ...] ordered by depth ASC

    for each (ancestorPageId, depth) in ancestors:   // depth 0 first
        userGrant ← findUserGrant(ancestorPageId, userId)
        groupGrants ← findGroupGrants(ancestorPageId, groups)

        if userGrant exists:
            return userGrant.level             // Rule 2: user wins over groups at same depth

        if groupGrants is non-empty:
            return max(groupGrants.level)      // Rule 3: most permissive group

        // No match at this depth → continue to next ancestor (Rule 1)

    // No grant found on any ancestor
    return workspaceDefault(pageId) ?? 'none'  // Rule 4
```

### Key property of the loop

The loop examines depths in ascending order and **returns on the first depth that has any applicable grant**. This is how Rule 1 (closest depth wins) is enforced — we never even look at deeper ancestors once we find a match.

### SQL implementation sketch

The actual implementation uses a single CTE query rather than a loop:

```sql
WITH ancestors AS (
    SELECT ancestor_id AS page_id, depth
    FROM page_tree_paths
    WHERE descendant_id = :pageId
),
user_groups AS (
    SELECT group_id
    FROM group_membership_closure
    WHERE user_id = :userId
),
grants AS (
    SELECT
        pp.permission_level,
        a.depth,
        CASE WHEN pp.user_id IS NOT NULL THEN 'user' ELSE 'group' END AS grantee_type
    FROM page_permissions pp
    JOIN ancestors a ON a.page_id = pp.page_id
    WHERE pp.user_id = :userId
       OR pp.group_id IN (SELECT group_id FROM user_groups)
),
ranked AS (
    SELECT *,
        ROW_NUMBER() OVER (
            ORDER BY
                depth ASC,                               -- Rule 1
                CASE WHEN grantee_type = 'user' THEN 0 ELSE 1 END,  -- Rule 2
                permission_level DESC                    -- Rule 3
        ) AS rn
    FROM grants
)
SELECT permission_level FROM ranked WHERE rn = 1;
```

If the query returns no rows, fall back to workspace default.

---

## 4. Edge Cases

### 4.1 No permissions anywhere

User has no direct grants, belongs to no groups with grants, no workspace default is set.

**Result:** `none`

### 4.2 Explicit `none` at target page

User has `none` set directly on the page. Parent has `full_access` for the same user.

**Result:** `none` — the depth-0 `none` wins by Rule 1. This is intentional: `none` is a first-class permission level, not special-cased.

### 4.3 `none` via group, overridden by user grant at same depth

Group "Contractors" has `none` on a page. User (a member of Contractors) has `write` on the same page.

**Result:** `write` — user grant wins by Rule 2.

### 4.4 `none` from one group, `write` from another at same depth

User is in Group A (`none` on page) and Group B (`write` on same page).

**Result:** `write` — Rule 3 takes the max across groups. `write > none`.

> **Important:** This means a group `none` grant cannot deny access if another group at the same depth grants higher access. To truly block a user, use a *user-level* `none` grant (Rule 2 ensures it wins over all groups).

### 4.5 Inherited `none` with no closer override

Grandparent has `none` for a user. Parent and target page have no grants.

**Result:** `none` — inherited from the grandparent. The `none` propagates down like any other level.

### 4.6 User in nested groups

Group A contains Group B. Group B contains User. Page has a grant for Group A only.

**Result:** The user is a transitive member of Group A (via `group_membership_closure`), so the grant applies. Nested group depth is irrelevant to page-tree depth.

### 4.7 Moving a page changes inheritance

Page X is under Parent A (which grants `write`). X is moved to Parent B (which grants `read`). X has no direct grants.

**Result before move:** `write` (inherited from A)
**Result after move:** `read` (inherited from B)

The closure table (`page_tree_paths`) is rebuilt for X and all descendants on move.

### 4.8 Workspace default with deeper override

Workspace default is `read`. Page at depth 3 has `write` for a group. Target page is a child of that page (depth 4), no direct grants.

**Result:** `write` — the group grant at depth 1 (relative to target) beats the workspace default. Workspace default is only consulted when *no* grant exists on *any* ancestor.

### 4.9 Multiple groups at different depths

User is in Group A (grant at depth 2) and Group B (grant at depth 0). Group A grants `full_access`, Group B grants `read`.

**Result:** `read` — Group B's grant at depth 0 wins by Rule 1, even though Group A's grant is more permissive.

### 4.10 Self-referencing closure entry

Every page has a `(page, page, depth=0)` entry in the closure table. A direct grant on a page is found at depth 0 through this self-reference. This is not a special case — it falls naturally out of the closure table structure.

---

## 5. Invariants

These properties must hold for all inputs. They are verified by property-based tests.

### INV-1: Determinism

```
resolvePermission(u, p) = resolvePermission(u, p)
```

Same inputs always produce the same output. No randomness, no ordering sensitivity.

### INV-2: Depth monotonicity

```
If grant G1 is at depth D1 and grant G2 is at depth D2, and D1 < D2,
then G1's level is used regardless of G2's level.
```

A closer grant always wins. There is no level high enough to override a closer grant.

### INV-3: Denial supremacy

```
If a user-level 'none' exists at depth D, and no grant exists at any depth < D,
then resolvePermission returns 'none'.
```

An explicit user-level denial cannot be overridden by any group grant at the same or greater depth. (It *can* be overridden by a closer grant at a smaller depth — that's Rule 1.)

### INV-4: Idempotency

```
setPermission(u, p, level); setPermission(u, p, level);
resolvePermission(u, p) is unchanged by the second set.
```

Duplicate writes are harmless.

### INV-5: Group monotonicity

```
Let R1 = resolvePermission(u, p) before adding u to group G.
Let R2 = resolvePermission(u, p) after adding u to group G.
Then R2 >= R1.
```

Adding a user to a group never reduces their effective access. This follows from Rule 3 (max across groups).

### INV-6: Inheritance correctness

```
If no grant exists for user u (directly or via groups) on any page
in the path from page p to the nearest ancestor with a grant,
then resolvePermission(u, p) = resolvePermission(u, nearestAncestorWithGrant).
```

Permissions propagate unchanged through pages that have no relevant grants.

### INV-7: Move correctness

```
After movePage(p, newParent):
resolvePermission(u, p) is computed using newParent's ancestor chain,
not the old parent's.
```

The closure table is the source of truth for ancestry. Moving a page fully cuts the old inheritance path.

---

## 6. Non-Obvious Design Decisions

**Why `none` is not special in the precedence rules:** `none` follows the same depth/user/group precedence as every other level. It is not a "trump card" — a closer `write` beats a farther `none`. This matches Notion's behavior: you can override a parent's denial by granting access on a child.

**Why user beats group (not the reverse):** In a system where hundreds of users are in dozens of groups, the most common administrative action is "give this specific person different access than their group." Making user grants win at the same depth means this is a single operation with predictable behavior.

**Why this works but wouldn't in a richer RBAC model:** Rule 2 is a winner-take-all decision between one scalar (user grant) and another scalar (best group grant). This is reasonable because our permission model has a single resource type (page) and a single ordered level. In an RBAC system with many resource/action pairs (e.g., `deploy:staging`, `read:secrets`, `write:repos`), a group role is a *curated bundle* of permissions — and a user-level override shouldn't blow away the entire bundle. Such systems need per-action merge semantics (union or intersection) rather than scalar comparison. If this system ever grows to support granular actions beyond the four levels, Rule 2 would need to be revisited.

**Why max-across-groups (not min):** The alternative — taking the *minimum* across groups — would mean that adding a user to a restrictive group could silently reduce their access through other groups. This violates the principle of least surprise. If you need to deny a specific user, use a user-level `none` grant.

**Why workspace default is last resort, not a floor:** The workspace default only applies when zero grants exist on any ancestor. It is *not* a minimum access level. An explicit `none` at any ancestor overrides the workspace default. This is because workspace defaults represent "what members get on unshared pages" — once explicit sharing begins, the explicit grants take over entirely.
