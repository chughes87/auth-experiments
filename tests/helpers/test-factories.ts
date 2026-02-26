import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import {
  UserId,
  GroupId,
  PageId,
  WorkspaceId,
  type PermissionLevel,
} from '../../src/shared/types.js';

/**
 * Helper factories for creating test data. All IDs are pre-generated UUIDs
 * so we can reference them before insertion.
 */

export function createUserId(): UserId {
  return UserId(uuid());
}

export function createGroupId(): GroupId {
  return GroupId(uuid());
}

export function createPageId(): PageId {
  return PageId(uuid());
}

export function createWorkspaceId(): WorkspaceId {
  return WorkspaceId(uuid());
}

export async function insertUser(
  db: Knex,
  id: UserId,
  name?: string,
): Promise<UserId> {
  const email = `${name ?? id}@test.com`;
  await db('users').insert({ id, email, name: name ?? `User ${id.slice(0, 8)}` });
  return id;
}

export async function insertWorkspace(
  db: Knex,
  id: WorkspaceId,
  ownerId: UserId,
  opts?: { defaultPermission?: PermissionLevel },
): Promise<WorkspaceId> {
  await db('workspaces').insert({
    id,
    name: `Workspace ${id.slice(0, 8)}`,
    owner_id: ownerId,
    default_permission: opts?.defaultPermission ?? 'none',
  });
  // Also add owner as workspace member
  await db('workspace_members').insert({
    workspace_id: id,
    user_id: ownerId,
    role: 'owner',
  });
  return id;
}

export async function addWorkspaceMember(
  db: Knex,
  workspaceId: WorkspaceId,
  userId: UserId,
  role: 'admin' | 'member' | 'guest' = 'member',
): Promise<void> {
  await db('workspace_members').insert({
    workspace_id: workspaceId,
    user_id: userId,
    role,
  });
}

export async function insertGroup(
  db: Knex,
  id: GroupId,
  workspaceId: WorkspaceId,
  name?: string,
): Promise<GroupId> {
  await db('groups').insert({
    id,
    workspace_id: workspaceId,
    name: name ?? `Group ${id.slice(0, 8)}`,
  });
  // Ensure self-referencing row in group_ancestor_paths
  await db('group_ancestor_paths')
    .insert({ ancestor_group_id: id, descendant_group_id: id, depth: 0 })
    .onConflict(['ancestor_group_id', 'descendant_group_id'])
    .ignore();
  return id;
}

export async function insertPage(
  db: Knex,
  id: PageId,
  workspaceId: WorkspaceId,
  createdBy: UserId,
  parentId?: PageId,
): Promise<PageId> {
  await db('pages').insert({
    id,
    workspace_id: workspaceId,
    parent_id: parentId ?? null,
    title: `Page ${id.slice(0, 8)}`,
    created_by: createdBy,
  });
  // The trigger handles closure table maintenance
  return id;
}

export async function setPermission(
  db: Knex,
  pageId: PageId,
  target: { userId: UserId } | { groupId: GroupId },
  permission: PermissionLevel,
): Promise<void> {
  await db('page_permissions').insert({
    page_id: pageId,
    user_id: 'userId' in target ? target.userId : null,
    group_id: 'groupId' in target ? target.groupId : null,
    permission,
  });
}

export async function addUserToGroup(
  db: Knex,
  groupId: GroupId,
  userId: UserId,
): Promise<void> {
  await db('group_members').insert({
    group_id: groupId,
    user_id: userId,
  });
}

export async function nestGroup(
  db: Knex,
  parentGroupId: GroupId,
  childGroupId: GroupId,
): Promise<void> {
  await db('group_members').insert({
    group_id: parentGroupId,
    child_group_id: childGroupId,
  });
}
