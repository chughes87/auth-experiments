import type { Knex } from 'knex';
import type { UserId, PageId, ResolvedPermission } from '../../shared/types.js';
import { invariant } from '../../shared/errors.js';
import { resolvePermission as resolvePermissionQuery } from './permission.repository.js';

/**
 * Resolve the effective permission for a user on a page.
 * Walks the page hierarchy from the target page upward, applying precedence rules:
 *   1. Closest depth wins
 *   2. User grant beats group grant at same depth
 *   3. Most permissive group wins at same depth
 *   4. No match → no_access
 */
export async function resolvePermission(
  db: Knex,
  userId: UserId,
  pageId: PageId,
): Promise<ResolvedPermission> {
  const result = await resolvePermissionQuery(db, userId, pageId);

  invariant(
    result.kind === 'direct' || result.kind === 'inherited' || result.kind === 'no_access',
    `Unexpected resolution result kind: ${(result as { kind: string }).kind}`,
  );

  return result;
}
