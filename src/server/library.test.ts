import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type DB } from './db';
import { Library } from './library';

let root: string;
let db: DB;
let lib: Library;
let inbox: string;
let library: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wcdoc-'));
  inbox = join(root, 'scans');
  library = join(root, 'documents');
  await mkdir(inbox);
  db = openDatabase(':memory:');
  lib = new Library(db, { inboxDir: inbox, libraryDir: library, dataDir: join(library, '.wcdoc') });
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

async function scan(name: string, content = name, mtime?: Date) {
  const p = join(inbox, name);
  await writeFile(p, content);
  if (mtime) await utimes(p, mtime, mtime);
  return p;
}

const base = { date: '2026-11-03', tags: [], notes: '' };

describe('inbox', () => {
  it('lists files oldest first, skipping dotfiles and directories', async () => {
    await scan('b.pdf', 'b', new Date('2026-11-02T10:00:00'));
    await scan('a.pdf', 'a', new Date('2026-11-05T10:00:00'));
    await scan('.hidden.pdf');
    await mkdir(join(inbox, '.adb-downloads.XYZ'));
    await mkdir(join(inbox, 'subdir'));
    const items = await lib.listInbox();
    expect(items.map((i) => i.name)).toEqual(['b.pdf', 'a.pdf']);
    expect(items[0]!.suggestedDate).toBe('2026-11-02');
  });

  it('returns an empty queue when the inbox dir does not exist', async () => {
    await rm(inbox, { recursive: true });
    expect(await lib.listInbox()).toEqual([]);
  });

  it('rejects path traversal and hidden names', async () => {
    await expect(lib.inboxFile('../x.pdf')).rejects.toThrow('Invalid');
    await expect(lib.inboxFile('.hidden')).rejects.toThrow('Invalid');
    await expect(lib.inboxFile('nope.pdf')).rejects.toThrow('not in the inbox');
  });
});

describe('filing', () => {
  it('moves the scan to <category>/<title>/<date>.pdf and indexes it', async () => {
    await scan('scan1.PDF', 'hello');
    const doc = await lib.fileItem('scan1.PDF', {
      ...base,
      category: ' Utilities ',
      title: 'Electricity: Bill',
      tags: ['power', 'Power', ' bills '],
      notes: 'Paid',
    });
    expect(doc.path).toBe('Utilities/Electricity- Bill/2026-11-03.pdf');
    expect(doc.tags).toEqual(['bills', 'power']);
    expect(doc.originalName).toBe('scan1.PDF');
    expect(await readFile(join(library, doc.path), 'utf8')).toBe('hello');
    expect(existsSync(join(inbox, 'scan1.PDF'))).toBe(false);
    expect(await lib.listInbox()).toEqual([]);
  });

  it('never overwrites: same title and date gets a suffix', async () => {
    await scan('1.pdf', 'one');
    await scan('2.pdf', 'two');
    const a = await lib.fileItem('1.pdf', { ...base, category: 'Tax', title: 'Return' });
    const b = await lib.fileItem('2.pdf', { ...base, category: 'Tax', title: 'Return' });
    expect(a.path).toBe('Tax/Return/2026-11-03.pdf');
    expect(b.path).toBe('Tax/Return/2026-11-03 (2).pdf');
    expect(await readFile(join(library, a.path), 'utf8')).toBe('one');
  });

  it('reuses existing category and title spelling case-insensitively', async () => {
    await scan('1.pdf', 'one');
    await scan('2.pdf', 'two');
    await lib.fileItem('1.pdf', { ...base, category: 'Utilities', title: 'Water Bill' });
    const b = await lib.fileItem('2.pdf', { ...base, category: 'utilities', title: 'water bill' });
    expect(b.path).toBe('Utilities/Water Bill/2026-11-03 (2).pdf');
    expect(lib.categories()).toEqual([{ name: 'Utilities', count: 2, titles: ['Water Bill'] }]);
  });

  it('flags duplicates of filed and discarded scans', async () => {
    await scan('1.pdf', 'same');
    const doc = await lib.fileItem('1.pdf', { ...base, category: 'A', title: 'B' });
    await scan('again.pdf', 'same');
    await scan('junk.pdf', 'junk');
    await lib.discardItem('junk.pdf');
    await scan('junk-again.pdf', 'junk');
    const items = await lib.listInbox();
    expect(items.find((i) => i.name === 'again.pdf')!.duplicate).toEqual({
      kind: 'document',
      id: doc.id,
      path: doc.path,
    });
    expect(items.find((i) => i.name === 'junk-again.pdf')!.duplicate).toEqual({
      kind: 'discarded',
      path: 'discarded/junk.pdf',
    });
  });

  it('validates input and leaves the scan in place on error', async () => {
    await scan('1.pdf');
    await expect(lib.fileItem('1.pdf', { ...base, category: '...', title: 'x' })).rejects.toThrow(
      'Category is required',
    );
    await expect(
      lib.fileItem('1.pdf', { ...base, category: 'a', title: 'x', date: '2026-02-30' }),
    ).rejects.toThrow('valid');
    expect(existsSync(join(inbox, '1.pdf'))).toBe(true);
    expect(existsSync(library)).toBe(false);
  });
});

describe('discard', () => {
  it('moves to the discard folder without deleting', async () => {
    await scan('bad.pdf', 'x');
    await scan('bad2.pdf', 'y');
    await lib.discardItem('bad.pdf');
    await writeFile(join(inbox, 'bad.pdf'), 'z');
    await lib.discardItem('bad.pdf');
    expect((await readdir(lib.discardDir)).sort()).toEqual(['bad (2).pdf', 'bad.pdf']);
    expect((await lib.listInbox()).map((i) => i.name)).toEqual(['bad2.pdf']);
  });
});

describe('editing and reorganizing', () => {
  async function fileOne(name: string, category: string, title: string, date = base.date) {
    await scan(name, name);
    return lib.fileItem(name, { ...base, date, category, title });
  }

  it('updates notes/tags without moving, and moves on category/title/date change', async () => {
    const doc = await fileOne('1.pdf', 'Misc', 'Letter');
    const tagged = await lib.updateDocument(doc.id, { tags: ['x'], notes: 'n' });
    expect(tagged.path).toBe(doc.path);
    expect(tagged.tags).toEqual(['x']);

    const moved = await lib.updateDocument(doc.id, {
      category: 'Medical',
      title: 'Referral',
      date: '2025-01-02',
    });
    expect(moved.path).toBe('Medical/Referral/2025-01-02.pdf');
    expect(moved.notes).toBe('n');
    expect(await readFile(join(library, moved.path), 'utf8')).toBe('1.pdf');
    // Empty old folders are cleaned up, and the orphaned category is dropped.
    expect(existsSync(join(library, 'Misc'))).toBe(false);
    expect(lib.categories().map((c) => c.name)).toEqual(['Medical']);
  });

  it('renames a category, including a case-only rename', async () => {
    await fileOne('1.pdf', 'utilities', 'Water');
    await fileOne('2.pdf', 'utilities', 'Gas');
    const report = await lib.renameCategory('UTILITIES', 'Utilities');
    expect(report.failed).toEqual([]);
    expect(report.moved).toHaveLength(2);
    expect(lib.listDocuments().map((d) => d.path)).toEqual([
      'Utilities/Gas/2026-11-03.pdf',
      'Utilities/Water/2026-11-03.pdf',
    ]);
    expect(await readdir(library)).toEqual(['Utilities']);
  });

  it('merges categories, adopting the target title spelling', async () => {
    await fileOne('1.pdf', 'Bills', 'water bill');
    await fileOne('2.pdf', 'Utilities', 'Water Bill');
    await lib.renameCategory('Bills', 'utilities');
    expect(lib.categories()).toEqual([{ name: 'Utilities', count: 2, titles: ['Water Bill'] }]);
    expect(
      lib
        .listDocuments()
        .map((d) => d.path)
        .sort(),
    ).toEqual(['Utilities/Water Bill/2026-11-03 (2).pdf', 'Utilities/Water Bill/2026-11-03.pdf']);
  });

  it('retitles a whole group and can move it to another category', async () => {
    await fileOne('1.pdf', 'Home', 'Insurance', '2025-01-01');
    await fileOne('2.pdf', 'Home', 'insurance', '2026-01-01');
    await fileOne('3.pdf', 'Home', 'Mortgage');
    const report = await lib.renameTitle('home', 'INSURANCE', 'Home Insurance', 'Insurance');
    expect(report.moved).toHaveLength(2);
    expect(lib.categories()).toEqual([
      { name: 'Home', count: 1, titles: ['Mortgage'] },
      { name: 'Insurance', count: 2, titles: ['Home Insurance'] },
    ]);
  });

  it('check reports missing, misplaced and untracked; adopt and reorganize fix them', async () => {
    const a = await fileOne('1.pdf', 'A', 'T');
    const b = await fileOne('2.pdf', 'B', 'T');
    await rm(join(library, a.path));
    // Simulate an interrupted move: metadata changed but file not relocated.
    db.prepare("UPDATE documents SET title = 'U' WHERE id = ?").run(b.id);
    await mkdir(join(library, 'C', 'Stray'), { recursive: true });
    await writeFile(join(library, 'C', 'Stray', '2024-05-06 scan.pdf'), 's');
    await writeFile(join(library, 'loose.pdf'), 'l');

    const report = await lib.check();
    expect(report.missing.map((d) => d.id)).toEqual([a.id]);
    expect(report.misplaced.map((d) => d.id)).toEqual([b.id]);
    expect(report.untracked).toEqual(['C/Stray/2024-05-06 scan.pdf', 'loose.pdf']);

    const adopted = await lib.adoptUntracked();
    expect(adopted.skipped).toEqual(['loose.pdf']);
    expect(adopted.adopted[0]).toMatchObject({ category: 'C', title: 'Stray', date: '2024-05-06' });

    const moves = await lib.reorganize();
    // The missing doc is already at its canonical path, so there's nothing to move (check reports it).
    expect(moves.failed).toEqual([]);
    expect(moves.moved.map((m) => m.to).sort()).toEqual([
      'B/U/2026-11-03.pdf',
      'C/Stray/2024-05-06.pdf',
    ]);
    const after = await lib.check();
    expect(after.misplaced).toEqual([]);
    expect(after.untracked).toEqual(['loose.pdf']);

    // Moving a document whose file is gone fails loudly rather than silently re-pointing it.
    await expect(lib.updateDocument(a.id, { title: 'New' })).rejects.toThrow('missing');
    expect(lib.getDocument(a.id).title).toBe('T');
  });

  it('searches across fields with every term required', async () => {
    const a = await fileOne('1.pdf', 'Utilities', 'Water Bill');
    await fileOne('2.pdf', 'Utilities', 'Gas Bill');
    await lib.updateDocument(a.id, { tags: ['quarterly'], notes: 'paid by card' });
    expect(lib.listDocuments({ q: 'bill' })).toHaveLength(2);
    expect(lib.listDocuments({ q: 'bill quarter' }).map((d) => d.id)).toEqual([a.id]);
    expect(lib.listDocuments({ q: 'card' }).map((d) => d.id)).toEqual([a.id]);
    expect(lib.listDocuments({ q: '100%' })).toEqual([]);
    expect(lib.listDocuments({ tag: 'QUARTERLY' }).map((d) => d.id)).toEqual([a.id]);
    expect(lib.listDocuments({ category: 'utilities' })).toHaveLength(2);
  });
});
