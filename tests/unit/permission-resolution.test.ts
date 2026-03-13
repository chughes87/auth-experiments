import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { Knex } from 'knex';
import { db } from '../../src/config/database.js';
import { resolvePermission } from '../../src/modules/permissions/permission.service.js';
import { UserId, PageId, GroupId } from '../../src/shared/types.js';

// Each test runs inside a transaction that is rolled back for isolation.
// Triggers automatically maintain closure tables when we insert into base tables.

let trx: Knex.Transaction;

beforeEach(async () => {
  trx = await db.transaction();
});

afterEach(async () => {
  await trx.rollback();
});

afterAll(async () => {
  await db.destroy();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createUser(name: string): Promise<UserId> {
  const [row] = await trx('users')
    .insert({ email: `${name}@test.com`, name })
    .returning('id');
  return UserId(row!.id);
}

async function createGroup(name: string): Promise<GroupId> {
  const [row] = await trx('groups')
    .insert({ name })
    .returning('id');
  return GroupId(row!.id);
}

async function addUserToGroup(groupId: GroupId, userId: UserId): Promise<void> {
  await trx('group_members').insert({ group_id: groupId, user_id: userId });
}

async function nestGroup(parentId: GroupId, childId: GroupId): Promise<void> {
  await trx('group_members').insert({ group_id: parentId, child_group_id: childId });
}

/** Create a page. Trigger populates page_tree_closure automatically. */
async function createPage(
  title: string,
  createdBy: UserId,
  parentId: PageId | null = null,
): Promise<PageId> {
  const [row] = await trx('pages')
    .insert({ title, created_by: createdBy, parent_id: parentId })
    .returning('id');
  return PageId(row!.id);
}

async function grantUser(
  pageId: PageId,
  userId: UserId,
  permission: string,
): Promise<void> {
  await trx('page_permissions').insert({
    page_id: pageId,
    user_id: userId,
    permission,
  });
}

async function grantGroup(
  pageId: PageId,
  groupId: GroupId,
  permission: string,
): Promise<void> {
  await trx('page_permissions').insert({
    page_id: pageId,
    group_id: groupId,
    permission,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('permission resolution', () => {
  it('returns no_access when no grants exist on any ancestor', async () => {
    const user = await createUser('alice');
    const root = await createPage('Root', user);
    const child = await createPage('Child', user, root);

    const result = await resolvePermission(trx, user, child);
    expect(result.kind).toBe('no_access');
  });

  it('resolves a direct grant on the target page', async () => {
    const user = await createUser('alice');
    const page = await createPage('Page', user);
    await grantUser(page, user, 'write');

    const result = await resolvePermission(trx, user, page);
    expect(result).toEqual({
      kind: 'direct',
      level: 'write',
      pageId: page,
    });
  });

  it('inherits permission from grandparent', async () => {
    const user = await createUser('alice');
    const grandparent = await createPage('Grandparent', user);
    const parent = await createPage('Parent', user, grandparent);
    const child = await createPage('Child', user, parent);

    await grantUser(grandparent, user, 'read');

    const result = await resolvePermission(trx, user, child);
    expect(result).toEqual({
      kind: 'inherited',
      level: 'read',
      fromPageId: grandparent,
      depth: 2,
    });
  });

  it('override at child level takes precedence over ancestor', async () => {
    const user = await createUser('alice');
    const parent = await createPage('Parent', user);
    const child = await createPage('Child', user, parent);

    await grantUser(parent, user, 'read');
    await grantUser(child, user, 'full_access');

    const result = await resolvePermission(trx, user, child);
    expect(result).toEqual({
      kind: 'direct',
      level: 'full_access',
      pageId: child,
    });
  });

  it('none blocks inherited access', async () => {
    const user = await createUser('alice');
    const parent = await createPage('Parent', user);
    const child = await createPage('Child', user, parent);

    await grantUser(parent, user, 'write');
    await grantUser(child, user, 'none');

    const result = await resolvePermission(trx, user, child);
    expect(result).toEqual({
      kind: 'direct',
      level: 'none',
      pageId: child,
    });
  });

  it('user-level beats group-level at same depth', async () => {
    const user = await createUser('alice');
    const group = await createGroup('team');
    await addUserToGroup(group, user);

    const page = await createPage('Page', user);
    await grantGroup(page, group, 'full_access');
    await grantUser(page, user, 'read');

    const result = await resolvePermission(trx, user, page);
    // User grant wins even though group grant is more permissive
    expect(result).toEqual({
      kind: 'direct',
      level: 'read',
      pageId: page,
    });
  });

  it('most permissive group wins at same depth', async () => {
    const user = await createUser('alice');
    const groupA = await createGroup('readers');
    const groupB = await createGroup('writers');
    await addUserToGroup(groupA, user);
    await addUserToGroup(groupB, user);

    const page = await createPage('Page', user);
    await grantGroup(page, groupA, 'read');
    await grantGroup(page, groupB, 'write');

    const result = await resolvePermission(trx, user, page);
    expect(result).toEqual({
      kind: 'direct',
      level: 'write',
      pageId: page,
    });
  });

  it('nested group membership grants access', async () => {
    const user = await createUser('alice');
    const parentGroup = await createGroup('engineering');
    const childGroup = await createGroup('frontend');
    await addUserToGroup(childGroup, user);
    await nestGroup(parentGroup, childGroup);

    const page = await createPage('Page', user);
    await grantGroup(page, parentGroup, 'write');

    const result = await resolvePermission(trx, user, page);
    // User is in frontend, which is nested in engineering, which has write on page
    expect(result).toEqual({
      kind: 'direct',
      level: 'write',
      pageId: page,
    });
  });
});
