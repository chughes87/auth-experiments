# Permission Resolution Design Space

First-principles exploration of the design space for hierarchical permission systems. Every system must answer four independent design questions. This document maps the options, tradeoffs, and how real systems combine them.

---

## The Core Problem

Given:
- A **hierarchy** of resources (pages)
- Multiple **sources** of permission (direct user grants, group grants, inherited grants, defaults)
- A user requesting access to a specific page

Determine: the effective access level.

---

## Dimension 1: Inheritance Model

How do grants on ancestor pages affect descendants?

### A. Closest-override

Walk up from the target. The first depth with any applicable grant wins. Everything above it is ignored.

```
Page A  [group: write]
  Page B  [user: read]     ← this wins for the user
    Page C  (no grant)     ← inherits read from B, not write from A
```

**Pro:** Simple mental model — "the nearest grant is what you get." Overrides are a single operation.
**Con:** A single grant at a close depth can shadow a richer set of grants further up. No way to say "add to what's inherited."

### B. Accumulative (union all ancestors)

Collect grants from *every* ancestor, merge them all. Closer grants don't replace — they contribute to a pool.

```
Page A  [group: write]
  Page B  [user: read]
    Page C  (no grant)     ← effective = max(write, read) = write
```

**Pro:** Adding a grant never reduces access. Easy to reason about: "what groups/users have grants anywhere above me?"
**Con:** You can never *restrict* a subtree below what an ancestor grants. A `read` grant on a child is meaningless if a parent grants `write`. The only tool for restriction is removing the ancestor grant, which affects all descendants.

### C. Explicit "block inheritance" flag

Default is accumulative, but a page can opt into "stop inheriting — start fresh from here."

```
Page A  [group: write]
  Page B  [block_inheritance = true, user: read]
    Page C  (no grant)     ← inherits read from B only. A's write is blocked.
```

**Pro:** Maximum flexibility — you choose per-page whether to inherit or override.
**Con:** Extra state to manage. "Why can't I access this?" becomes a harder debugging problem — you have to find the blocking page. Common in CMS systems (Drupal, SharePoint).

### D. Subtree grants

A grant explicitly declares its scope: "this page only" vs "this page and all descendants."

```
Page A  [group: write, scope: subtree]
  Page B  [user: read, scope: this_page_only]
    Page C  (no grant)     ← gets write from A (subtree), not read from B (page-only)
```

**Pro:** Very precise. Admins declare intent explicitly.
**Con:** Combinatorial complexity. What happens when a subtree grant and a page-only grant conflict? You now need rules for scope interaction *on top of* depth, user/group, etc.

---

## Dimension 2: Merge Strategy

When multiple grants apply at the same "level" (however you define it), how do you combine them?

### A. Max (most permissive wins)

```
Group A: read  +  Group B: write  →  write
```

**Pro:** Adding a user to a group never hurts. Simple.
**Con:** Can't model "Group A restricts access" — any other group can override it. The only restriction tool is explicit denial.

### B. Min (most restrictive wins)

```
Group A: read  +  Group B: write  →  read
```

**Pro:** A restrictive group is a hard ceiling. Good for compliance ("Interns group caps at read").
**Con:** Adding someone to a group can *reduce* their access. Extremely surprising. Users file "I lost access" bugs constantly.

### C. Priority ordering

Define a total order on grantee types: user > role > group > default. Highest-priority source wins; others ignored.

```
User: read  +  Group: write  →  read (user priority wins)
```

**Pro:** Predictable. One clear winner.
**Con:** The winner-take-all problem — in a scalar model it's fine, but in a rich RBAC model it discards the group's full policy bundle.

### D. Per-action union (for multi-action systems)

Each grant is a *set* of actions. Merge = set union across all sources.

```
Group A: {read, comment}  +  Group B: {read, deploy}  →  {read, comment, deploy}
```

**Pro:** The natural model for RBAC with many resource/action pairs. Each group contributes its specific capabilities.
**Con:** Doesn't apply to scalar models. Denial requires a separate mechanism (deny lists). More complex to reason about.

---

## Dimension 3: Denial Model

How do you explicitly remove access?

### A. `none` as a regular level

`none` participates in the same precedence rules as everything else. It's just the lowest level.

**Pro:** Uniform rules. No special cases.
**Con:** `none` can be overridden by a more permissive group at the same depth (via max merge). To truly deny, you need a user-level grant.

### B. Deny as trump card (NTFS, AWS IAM)

An explicit deny *always* wins, regardless of depth, grantee type, or anything else.

```
Page A  [user: full_access]
  Page B  [group: deny]     ← deny wins even though it's deeper and group-level
```

**Pro:** Security teams love it. "If anyone anywhere says deny, the answer is deny." Easy to audit.
**Con:** A single misplaced deny can lock out an entire subtree and be very hard to debug. "Deny always wins" means you can't override a deny on a child page — you have to find and remove the deny itself. In practice, NTFS permission debugging is notoriously painful.

### C. No explicit deny (remove-only)

There is no `none` level. To remove access, you delete the grant, reverting to inheritance. If you want someone to not access a child page, you restructure the tree or remove them from the group.

**Pro:** Simplest possible model. No "deny vs absence" confusion.
**Con:** You can't restrict a subtree. If a group has `write` on a parent, every child inherits `write` with no override mechanism short of restructuring.

### D. Scoped deny

Deny is explicit but has a scope: "deny on this page" vs "deny on this subtree." A subtree deny cascades, a page deny doesn't.

**Pro:** Fine-grained control.
**Con:** Yet another axis of complexity.

---

## Dimension 4: User vs. Group Interaction

When a user has a direct grant *and* applicable group grants, how do they interact?

### A. User always wins

User grant replaces group consideration at that depth.

**Pro:** "Direct grants are deliberate overrides." Single scalar comparison.
**Con:** User grant can accidentally cap access below group level.

### B. Max of user and groups

```
User: read  +  Group: write  →  write
```

User grants can only *elevate*, never restrict below groups. To restrict, use `none`.

**Pro:** No accidental restriction. User grant is purely additive.
**Con:** You can't express "this user should have read even though their group has write" without using `none` (which blocks entirely rather than capping).

### C. User grant as independent overlay

User grant and group grants are evaluated separately. User gets the higher of the two.

This is effectively the same as B for a scalar model, but distinct in a multi-action system where the user might have `{comment}` and the group has `{read, write}` — union gives `{read, write, comment}`.

### D. No distinction

User and group grants are all just "grants." No priority between them. Merge strategy (max/min/union) applies uniformly.

**Pro:** Simplest. No special cases.
**Con:** No way to say "this specific person" as distinct from "this group they're in."

---

## Real Systems Compared

| System | Inheritance | Merge | Denial | User vs Group |
|--------|------------|-------|--------|---------------|
| **Notion** (our model) | Closest-override | Max | `none` as regular level | User wins |
| **NTFS/Windows** | Accumulative | Union (per-action) | Deny trumps all | No distinction |
| **AWS IAM** | N/A (flat) | Union | Deny trumps all | N/A (policies only) |
| **Google Drive** | Closest-override | Max | Remove-only (no deny) | No distinction |
| **SharePoint** | Block-inheritance flag | Union (per-action) | Break + reassign | Role-based priority |
| **Unix filesystem** | None (per-file) | Priority (owner > group > other) | No deny (just no grant) | Owner wins |
| **POSIX ACL** | Inheritance optional | Priority + mask | Deny entries exist | User > group |

---

## The Key Tradeoffs

Two fundamental tensions underlie the entire design space:

### 1. Expressiveness vs. debuggability

More dimensions (scoped deny, block-inheritance flags, subtree grants) let admins express finer intent, but make "why does this user have this access?" exponentially harder to answer. NTFS is the cautionary tale — maximum expressiveness, minimum debuggability.

### 2. Restrictive power vs. surprise

If the system makes it easy to restrict (deny trumps, min merge), then routine operations (adding to a group, granting access) can have unexpected negative effects. If the system makes restriction hard (max merge, no deny), it's predictable but admins lack tools to lock things down.

---

## Where Our Model Sits

Our system chooses: **closest-override + max merge + `none` as regular level + user wins over group.** There is no workspace or tenant-level default fallback — if no grant exists on any ancestor, the result is `none`.

This is less expressive than NTFS but much easier to reason about. It optimizes for:
- **Predictability:** the nearest grant determines the outcome, no action-at-a-distance
- **Safety of additive operations:** adding grants or group memberships never reduces access
- **Simple debugging:** "find the closest grant" is a linear scan up the tree
- **Explicit access only:** no implicit defaults — access must be deliberately granted

The known limitations:
- No way to "add to" an inherited permission without overriding it
- User-beats-group is winner-take-all, which works for a scalar permission level but would not work for a rich RBAC model with many resource/action pairs (see `resolution-spec.md` section 6)
- `none` can be overridden by a more permissive group at the same depth — true denial requires a user-level grant
