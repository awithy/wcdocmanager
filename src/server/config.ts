import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const envSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4317),
  INBOX_DIR: z.string().default('~/personal/scans'),
  LIBRARY_DIR: z.string().default('~/personal/documents'),
  DATA_DIR: z.string().optional(),
  PULL_SCRIPT: z.string().default('~/personal/pull-downloads.sh'),
  WEB_DIST: z.string().optional(),
});

export interface Config {
  host: string;
  port: number;
  inboxDir: string;
  libraryDir: string;
  /** Holds the SQLite index and discarded scans. Must be on the same filesystem as the inbox. */
  dataDir: string;
  /** Null disables the Import button. */
  pullScript: string | null;
  webDist: string;
}

export function expandPath(p: string): string {
  const expanded = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return resolve(expanded);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  const libraryDir = expandPath(e.LIBRARY_DIR);
  return {
    host: e.HOST,
    port: e.PORT,
    inboxDir: expandPath(e.INBOX_DIR),
    libraryDir,
    dataDir: e.DATA_DIR ? expandPath(e.DATA_DIR) : join(libraryDir, '.wcdocmanager'),
    pullScript: e.PULL_SCRIPT.trim() ? expandPath(e.PULL_SCRIPT.trim()) : null,
    webDist: e.WEB_DIST
      ? expandPath(e.WEB_DIST)
      : resolve(dirname(fileURLToPath(import.meta.url)), '../../dist'),
  };
}
