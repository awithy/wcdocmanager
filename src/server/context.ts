import { join } from 'node:path';
import type { Config } from './config';
import { openDatabase } from './db';
import { Library } from './library';

/** Shared by the server and the CLI: both operate directly on the same index and folders. */
export function openLibrary(config: Config, log?: ConstructorParameters<typeof Library>[2]) {
  const db = openDatabase(join(config.dataDir, 'index.sqlite'));
  const library = new Library(
    db,
    { inboxDir: config.inboxDir, libraryDir: config.libraryDir, dataDir: config.dataDir },
    log,
  );
  return { db, library };
}
