import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { openDatabase, type DB } from './db';
import { Library } from './library';

let root: string;
let db: DB;
let app: Awaited<ReturnType<typeof buildApp>>;

const local = { host: '127.0.0.1:4317' };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wcdoc-app-'));
  const inbox = join(root, 'scans');
  await mkdir(inbox);
  await writeFile(join(inbox, 'scan 1.pdf'), '%PDF-1.4 test');
  db = openDatabase(':memory:');
  const library = new Library(db, {
    inboxDir: inbox,
    libraryDir: join(root, 'documents'),
    dataDir: join(root, 'documents', '.wcdoc'),
  });
  const script = join(root, 'pull.sh');
  await writeFile(script, '#!/bin/sh\necho pulled\n', { mode: 0o755 });
  app = await buildApp({ library, pullScript: script });
});

afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

describe('api', () => {
  it('files an inbox item end to end', async () => {
    const inbox = await app.inject({ url: '/api/inbox', headers: local });
    expect(inbox.json()).toHaveLength(1);

    const content = await app.inject({ url: '/api/inbox/scan%201.pdf/content', headers: local });
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.body).toBe('%PDF-1.4 test');

    const filed = await app.inject({
      method: 'POST',
      url: '/api/inbox/scan%201.pdf/file',
      headers: { ...local, origin: 'http://127.0.0.1:4317' },
      payload: { category: 'Tax', title: 'Return', date: '2026-04-01', tags: ['2025'] },
    });
    expect(filed.statusCode).toBe(201);
    expect(filed.json()).toMatchObject({ path: 'Tax/Return/2026-04-01.pdf', tags: ['2025'] });

    const docs = await app.inject({ url: '/api/documents?q=return', headers: local });
    expect(docs.json()).toHaveLength(1);
    const id = docs.json()[0].id as number;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/documents/${id}`,
      headers: local,
      payload: { title: 'Federal Return' },
    });
    expect(patched.json().path).toBe('Tax/Federal Return/2026-04-01.pdf');

    const file = await app.inject({ url: `/api/documents/${id}/content`, headers: local });
    expect(file.body).toBe('%PDF-1.4 test');
  });

  it('returns readable validation and not-found errors', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/api/inbox/scan%201.pdf/file',
      headers: local,
      payload: { category: '', title: 'x', date: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toContain('Category is required');

    const missing = await app.inject({ url: '/api/inbox/other.pdf/content', headers: local });
    expect(missing.statusCode).toBe(404);
    const traversal = await app.inject({ url: '/api/inbox/..%2Fx/content', headers: local });
    expect(traversal.statusCode).toBe(400);
  });

  it('rejects foreign Host headers and cross-origin writes', async () => {
    const rebinding = await app.inject({ url: '/api/inbox', headers: { host: 'evil.example' } });
    expect(rebinding.statusCode).toBe(403);
    const csrf = await app.inject({
      method: 'POST',
      url: '/api/inbox/scan%201.pdf/discard',
      headers: { ...local, origin: 'https://evil.example' },
    });
    expect(csrf.statusCode).toBe(403);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/inbox/scan%201.pdf/discard',
      headers: local,
    });
    expect(ok.statusCode).toBe(204);
  });

  it('runs the import script', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/import', headers: local });
    expect(res.json()).toEqual({ ok: true, output: 'pulled\n' });
  });
});
