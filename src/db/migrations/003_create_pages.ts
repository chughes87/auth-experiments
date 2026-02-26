import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('uuid_generate_v4()'));
    table.uuid('parent_id').nullable().references('id').inTable('pages').onDelete('CASCADE');
    table.string('title').notNullable();
    table.text('content').defaultTo('');
    table.uuid('created_by').notNullable().references('id').inTable('users').onDelete('RESTRICT');
    table.timestamps(true, true);
  });

  // Page hierarchy closure table
  // Every page has a self-referencing row (depth 0) plus rows for all ancestors
  await knex.schema.createTable('page_tree_paths', (table) => {
    table.uuid('ancestor_id').notNullable().references('id').inTable('pages').onDelete('CASCADE');
    table.uuid('descendant_id').notNullable().references('id').inTable('pages').onDelete('CASCADE');
    table.integer('depth').notNullable();
    table.primary(['ancestor_id', 'descendant_id']);
  });

  // Index for "find all ancestors of page X" (used by permission resolution)
  await knex.raw(`
    CREATE INDEX page_tree_paths_descendant_depth
    ON page_tree_paths (descendant_id, depth ASC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('page_tree_paths');
  await knex.schema.dropTableIfExists('pages');
}
