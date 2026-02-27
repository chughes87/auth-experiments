import type { Knex } from 'knex';
import { PageId, maxPermissionLevel, type UserId, type ResolvedPermission, type PermissionLevel } from '../../shared/types.js';
import { getAncestors, getUserGrants, getGroupGrants } from './permission.repository.js';

/**
 * Resolve the effective permission for a user on a page.
 *
 * Precedence rules (applied in order):
 *   1. Closest depth wins — walk from target page upward
 *   2. User grant beats group grant at same depth
 *   3. Most permissive group wins at same depth
 *   4. No match on any ancestor → no_access
 */
export async function resolvePermission(
  db: Knex,
  userId: UserId,
  pageId: PageId,
): Promise<ResolvedPermission> {
  // Step 1: Get all ancestors ordered by depth (self at depth 0)
  const ancestors = await getAncestors(db, pageId);
  if (ancestors.length === 0) {
    return { kind: 'no_access' };
  }

  const pageIds = ancestors.map((a) => a.ancestor_id);

  // Step 2: Fetch user and group grants on all ancestor pages
  const [userGrants, groupGrants] = await Promise.all([
    getUserGrants(db, userId, pageIds),
    getGroupGrants(db, userId, pageIds),
  ]);

  // Index grants by page_id for fast lookup
  const userGrantByPage = new Map<string, PermissionLevel>();
  for (const g of userGrants) {
    userGrantByPage.set(g.page_id, g.permission);
  }

  const groupGrantsByPage = new Map<string, PermissionLevel[]>();
  for (const g of groupGrants) {
    const existing = groupGrantsByPage.get(g.page_id);
    if (existing) {
      existing.push(g.permission);
    } else {
      groupGrantsByPage.set(g.page_id, [g.permission]);
    }
  }

  // Step 3: Walk ancestors from closest to farthest, apply precedence
  for (const ancestor of ancestors) {
    const userGrant = userGrantByPage.get(ancestor.ancestor_id);
    const groupLevels = groupGrantsByPage.get(ancestor.ancestor_id);

    // User grant wins over group at same depth
    if (userGrant !== undefined) {
      return ancestor.depth === 0
        ? { kind: 'direct', level: userGrant, pageId: PageId(ancestor.ancestor_id) }
        : { kind: 'inherited', level: userGrant, fromPageId: PageId(ancestor.ancestor_id), depth: ancestor.depth };
    }

    // Most permissive group wins
    if (groupLevels && groupLevels.length > 0) {
      const level = groupLevels.reduce(maxPermissionLevel);
      return ancestor.depth === 0
        ? { kind: 'direct', level, pageId: PageId(ancestor.ancestor_id) }
        : { kind: 'inherited', level, fromPageId: PageId(ancestor.ancestor_id), depth: ancestor.depth };
    }
  }

  return { kind: 'no_access' };
}
