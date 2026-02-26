import type { Knex } from 'knex';

/**
 * Run a callback inside a transaction. If the callback throws, the transaction
 * is rolled back automatically.
 */
export async function withTransaction<T>(
  db: Knex,
  fn: (trx: Knex.Transaction) => Promise<T>,
): Promise<T> {
  return db.transaction(fn);
}
