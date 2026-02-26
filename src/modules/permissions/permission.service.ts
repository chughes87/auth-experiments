import type { Knex } from 'knex';
import type { UserId, PageId, ResolvedPermission, PermissionLevel } from '../../shared/types.js';
import { PERMISSION_LEVELS, PageId as makePageId } from '../../shared/types.js';
import { invariant } from '../../shared/errors.js';
import { PermissionRepository } from './permission.repository.js';

export class PermissionService {
  private readonly repo: PermissionRepository;

  constructor(db: Knex) {
    this.repo = new PermissionRepository(db);
  }

  /**
   * Resolve the effective permission for a user on a page.
   *
   * Resolution order:
   * 1. Walk page ancestors from closest to farthest, applying precedence rules
   * 2. Fall back to workspace default (if user is workspace member)
   * 3. Default to no_access
   */
  async resolvePermission(userId: UserId, pageId: PageId): Promise<ResolvedPermission> {
    // Step 1: Check page tree for explicit permissions
    const row = await this.repo.resolveFromPageTree(userId, pageId);

    if (row) {
      // Post-condition: returned permission must be a valid level
      invariant(
        (PERMISSION_LEVELS as readonly string[]).includes(row.permission),
        `Invalid resolved permission level: ${row.permission}`,
      );

      if (row.depth === 0) {
        return {
          kind: 'direct',
          level: row.permission,
          pageId: makePageId(row.page_id),
        };
      }

      return {
        kind: 'inherited',
        level: row.permission,
        fromPageId: makePageId(row.page_id),
        depth: row.depth,
      };
    }

    // Step 2: Fall back to workspace default
    const workspaceDefault = await this.repo.getWorkspaceDefault(userId, pageId);
    if (workspaceDefault && workspaceDefault !== 'none') {
      return {
        kind: 'workspace_default',
        level: workspaceDefault,
      };
    }

    // Step 3: No access
    return { kind: 'no_access' };
  }

  /**
   * Check if a user has at least the required permission level on a page.
   */
  async hasPermission(
    userId: UserId,
    pageId: PageId,
    required: PermissionLevel,
  ): Promise<boolean> {
    const { isAtLeast, resolvedPermissionLevel } = await import('../../shared/types.js');
    const resolved = await this.resolvePermission(userId, pageId);
    return isAtLeast(resolvedPermissionLevel(resolved), required);
  }
}
