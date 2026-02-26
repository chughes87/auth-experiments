import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PermissionService } from '../../../src/modules/permissions/permission.service.js';
import { PageTreeService } from '../../../src/modules/pages/page-tree.service.js';
import {
  setupTestDb,
  cleanAllTables,
  teardownTestDb,
} from '../../helpers/db-setup.js';
import {
  createUserId,
  createGroupId,
  createPageId,
  createWorkspaceId,
  insertUser,
  insertWorkspace,
  addWorkspaceMember,
  insertGroup,
  insertPage,
  setPermission,
  addUserToGroup,
  nestGroup,
} from '../../helpers/test-factories.js';
import type { Knex } from 'knex';

let db: Knex;
let permissionService: PermissionService;
let pageTreeService: PageTreeService;

beforeAll(async () => {
  db = await setupTestDb();
  permissionService = new PermissionService(db);
  pageTreeService = new PageTreeService(db);
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await cleanAllTables(db);
});

describe('Permission Resolution', () => {
  it('inherits permission from grandparent', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const grandparent = createPageId();
    const parent = createPageId();
    const child = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);

    await insertPage(db, grandparent, ws, owner);
    await insertPage(db, parent, ws, owner, grandparent);
    await insertPage(db, child, ws, owner, parent);

    // Set write on grandparent only
    await setPermission(db, grandparent, { userId: user }, 'write');

    const result = await permissionService.resolvePermission(user, child);
    expect(result.kind).toBe('inherited');
    expect(result).toMatchObject({
      kind: 'inherited',
      level: 'write',
      fromPageId: grandparent,
      depth: 2,
    });
  });

  it('override at child level takes precedence over parent', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const parent = createPageId();
    const child = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);

    await insertPage(db, parent, ws, owner);
    await insertPage(db, child, ws, owner, parent);

    await setPermission(db, parent, { userId: user }, 'write');
    await setPermission(db, child, { userId: user }, 'read');

    const result = await permissionService.resolvePermission(user, child);
    expect(result).toMatchObject({
      kind: 'direct',
      level: 'read',
      pageId: child,
    });
  });

  it('none blocks inherited access', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const parent = createPageId();
    const child = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);

    await insertPage(db, parent, ws, owner);
    await insertPage(db, child, ws, owner, parent);

    await setPermission(db, parent, { userId: user }, 'write');
    await setPermission(db, child, { userId: user }, 'none');

    const result = await permissionService.resolvePermission(user, child);
    expect(result).toMatchObject({
      kind: 'direct',
      level: 'none',
      pageId: child,
    });
  });

  it('user-level grant beats group-level at same depth', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const group = createGroupId();
    const page = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);
    await insertGroup(db, group, ws, 'Engineering');
    await addUserToGroup(db, group, user);

    await insertPage(db, page, ws, owner);

    // Group grants write, user grants read — user grant wins
    await setPermission(db, page, { groupId: group }, 'write');
    await setPermission(db, page, { userId: user }, 'read');

    const result = await permissionService.resolvePermission(user, page);
    expect(result).toMatchObject({
      kind: 'direct',
      level: 'read',
      pageId: page,
    });
  });

  it('most permissive group grant wins at same depth', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const group1 = createGroupId();
    const group2 = createGroupId();
    const page = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);
    await insertGroup(db, group1, ws, 'Group A');
    await insertGroup(db, group2, ws, 'Group B');
    await addUserToGroup(db, group1, user);
    await addUserToGroup(db, group2, user);

    await insertPage(db, page, ws, owner);

    // Group A grants read, Group B grants write — write wins
    await setPermission(db, page, { groupId: group1 }, 'read');
    await setPermission(db, page, { groupId: group2 }, 'write');

    const result = await permissionService.resolvePermission(user, page);
    expect(result).toMatchObject({
      kind: 'direct',
      level: 'write',
      pageId: page,
    });
  });

  it('nested group membership grants access', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const parentGroup = createGroupId();
    const childGroup = createGroupId();
    const page = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);
    await insertGroup(db, parentGroup, ws, 'All Engineering');
    await insertGroup(db, childGroup, ws, 'Backend Team');

    // User is in Backend Team, which is nested in All Engineering
    await addUserToGroup(db, childGroup, user);
    await nestGroup(db, parentGroup, childGroup);

    await insertPage(db, page, ws, owner);
    await setPermission(db, page, { groupId: parentGroup }, 'write');

    const result = await permissionService.resolvePermission(user, page);
    expect(result).toMatchObject({
      kind: 'direct',
      level: 'write',
      pageId: page,
    });
  });

  it('falls back to workspace default when no page-level permissions exist', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const page = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner, { defaultPermission: 'read' });
    await addWorkspaceMember(db, ws, user);

    await insertPage(db, page, ws, owner);

    const result = await permissionService.resolvePermission(user, page);
    expect(result).toMatchObject({
      kind: 'workspace_default',
      level: 'read',
    });
  });

  it('returns no_access when no permissions exist and workspace default is none', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const page = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner); // default_permission = 'none'
    await addWorkspaceMember(db, ws, user);

    await insertPage(db, page, ws, owner);

    const result = await permissionService.resolvePermission(user, page);
    expect(result.kind).toBe('no_access');
  });

  it('moving a page updates permission inheritance', async () => {
    const owner = createUserId();
    const user = createUserId();
    const ws = createWorkspaceId();
    const parentA = createPageId();
    const parentB = createPageId();
    const child = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, user, 'user');
    await insertWorkspace(db, ws, owner);
    await addWorkspaceMember(db, ws, user);

    await insertPage(db, parentA, ws, owner);
    await insertPage(db, parentB, ws, owner);
    await insertPage(db, child, ws, owner, parentA);

    await setPermission(db, parentA, { userId: user }, 'read');
    await setPermission(db, parentB, { userId: user }, 'write');

    // Before move: child inherits read from parentA
    let result = await permissionService.resolvePermission(user, child);
    expect(result).toMatchObject({ kind: 'inherited', level: 'read' });

    // Move child under parentB
    await db.transaction(async (trx) => {
      await pageTreeService.movePage(child, parentB, trx);
    });

    // After move: child inherits write from parentB
    result = await permissionService.resolvePermission(user, child);
    expect(result).toMatchObject({ kind: 'inherited', level: 'write' });
  });
});
