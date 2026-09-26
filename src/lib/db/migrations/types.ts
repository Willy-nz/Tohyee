/**
 * A migration is plain SQL applied once, in order, inside its own transaction.
 *
 * Never edit a migration after it has been released: the runner stores a
 * checksum of each migration and refuses to start if an applied one changes.
 * Add a new migration instead.
 */
export type Migration = {
  version: string;
  name: string;
  sql: string;
};
