import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  setupTestDb,
  cleanAllTables,
  teardownTestDb,
} from '../helpers/db-setup.js';
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
} from '../helpers/test-factories.js';
import {
  RESOLVE_PERMISSION_SQL,
} from '../../src/modules/permissions/permission.repository.js';
import type { Knex } from 'knex';

let db: Knex;

beforeAll(async () => {
  db = await setupTestDb();
});

afterAll(async () => {
  await teardownTestDb();
});

beforeEach(async () => {
  await cleanAllTables(db);
});

describe('Resolution SQL Query Snapshot', () => {
  it('resolves a standard fixture correctly', async () => {
    // Set up the README example scenario:
    // Engineering (group "Eng Team" has write)
    //   └── Roadmap (no permissions)
    //     └── Q2 Goals (group "Leadership" has full_access, alice has none)

    const owner = createUserId();
    const bob = createUserId();
    const carol = createUserId();
    const alice = createUserId();
    const ws = createWorkspaceId();
    const engGroup = createGroupId();
    const leadershipGroup = createGroupId();
    const engineering = createPageId();
    const roadmap = createPageId();
    const q2Goals = createPageId();

    await insertUser(db, owner, 'owner');
    await insertUser(db, bob, 'bob');
    await insertUser(db, carol, 'carol');
    await insertUser(db, alice, 'alice');

    await insertWorkspace(db, ws, owner, { defaultPermission: 'read' });
    await addWorkspaceMember(db, ws, bob);
    await addWorkspaceMember(db, ws, carol);
    await addWorkspaceMember(db, ws, alice);

    await insertGroup(db, engGroup, ws, 'Eng Team');
    await insertGroup(db, leadershipGroup, ws, 'Leadership');

    await addUserToGroup(db, engGroup, bob);
    await addUserToGroup(db, engGroup, carol);
    await addUserToGroup(db, leadershipGroup, carol);
    await addUserToGroup(db, engGroup, alice);

    await insertPage(db, engineering, ws, owner);
    await insertPage(db, roadmap, ws, owner, engineering);
    await insertPage(db, q2Goals, ws, owner, roadmap);

    await setPermission(db, engineering, { groupId: engGroup }, 'write');
    await setPermission(db, q2Goals, { groupId: leadershipGroup }, 'full_access');
    await setPermission(db, q2Goals, { userId: alice }, 'none');

    // Bob on Q2 Goals: no match at Q2 Goals, no match at Roadmap, group match at Engineering → write
    const bobResult = await db.raw(RESOLVE_PERMISSION_SQL, {
      userId: bob,
      pageId: q2Goals,
    });
    expect(bobResult.rows).toMatchSnapshot('bob-on-q2-goals');

    // Carol on Q2 Goals: group match at Q2 Goals (Leadership → full_access)
    const carolResult = await db.raw(RESOLVE_PERMISSION_SQL, {
      userId: carol,
      pageId: q2Goals,
    });
    expect(carolResult.rows).toMatchSnapshot('carol-on-q2-goals');

    // Alice on Q2 Goals: user match at Q2 Goals → none
    const aliceResult = await db.raw(RESOLVE_PERMISSION_SQL, {
      userId: alice,
      pageId: q2Goals,
    });
    expect(aliceResult.rows).toMatchSnapshot('alice-on-q2-goals');
  });
});
