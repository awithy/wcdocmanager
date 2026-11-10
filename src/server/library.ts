import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileExtension, isValidIsoDate, localIsoDate, sanitizeName } from '../shared/names';
import {
  fileInputSchema,
  nameSchema,
  updateDocumentSchema,
  type CategorySummary,
  type CheckReport,
  type DocumentRecord,
  type Duplicate,
  type FileInput,
  type InboxItem,
  type Move,
  type MoveReport,
  type TagSummary,
  type UpdateDocumentInput,
} from '../shared/types';
import type { DB } from './db';
import { badRequest, conflict, notFound } from './errors';
import { isInside, Mutex, placeNoClobber, removeEmptyDirs, sha256File } from './fsops';

export interface LibraryPaths {
  inboxDir: string;
  libraryDir: string;
  dataDir: string;
}

export interface DocumentQuery {
  q?: string;
  category?: string;
  tag?: string;
}

interface DocumentRow {
  id: number;
  category: string;
  category_id: number;
  title: string;
  doc_date: string;
  rel_path: string;
  original_name: string;
  sha256: string;
  size: number;
  notes: string;
  filed_at: string;
  updated_at: string;
}

type Logger = { warn: (obj: object, msg: string) => void };

const nowIso = () => new Date().toISOString();

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

const DOC_SELECT = `
  SELECT d.*, c.name AS category
  FROM documents d JOIN categories c ON c.id = d.category_id`;

export class Library {
  private readonly mutex = new Mutex();
  private readonly hashCache = new Map<string, { size: number; mtimeMs: number; sha: string }>();

  constructor(
    private readonly db: DB,
    readonly paths: LibraryPaths,
    private readonly log: Logger = { warn: () => {} },
  ) {}

  get discardDir() {
    return join(this.paths.dataDir, 'discarded');
  }

  // ---------------------------------------------------------------- inbox

  async listInbox(): Promise<InboxItem[]> {
    let entries;
    try {
      entries = await readdir(this.paths.inboxDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const items: InboxItem[] = [];
    const seen = new Set<string>();
    for (const entry of entries) {
      // Skips dotfiles, including pull-downloads.sh's in-progress .adb-downloads.* staging dirs.
      if (!entry.isFile() || entry.name.startsWith('.')) continue;
      const path = join(this.paths.inboxDir, entry.name);
      let st;
      try {
        st = await lstat(path);
      } catch {
        continue; // Vanished mid-listing.
      }
      seen.add(entry.name);
      const sha = await this.cachedHash(entry.name, path, st.size, st.mtimeMs);
      items.push({
        name: entry.name,
        size: st.size,
        modifiedAt: st.mtime.toISOString(),
        suggestedDate: localIsoDate(st.mtime),
        sha256: sha,
        duplicate: this.findDuplicate(sha),
      });
    }
    for (const name of this.hashCache.keys()) if (!seen.has(name)) this.hashCache.delete(name);
    // Oldest first: it's a queue.
    return items.sort(
      (a, b) => a.modifiedAt.localeCompare(b.modifiedAt) || a.name.localeCompare(b.name),
    );
  }

  /** Absolute path of an inbox file; rejects anything that isn't a plain regular file there. */
  async inboxFile(name: string): Promise<string> {
    if (!name || name !== basename(name) || name.startsWith('.')) {
      throw badRequest('Invalid file name');
    }
    const path = join(this.paths.inboxDir, name);
    try {
      if ((await lstat(path)).isFile()) return path;
    } catch {
      // Fall through.
    }
    throw notFound(`'${name}' is not in the inbox`);
  }

  fileItem(name: string, input: FileInput): Promise<DocumentRecord> {
    return this.mutex.run(async () => {
      const src = await this.inboxFile(name);
      const data = fileInputSchema.parse(input);
      const category = this.canonicalCategory(data.category);
      const title = this.canonicalTitle(category, data.title);
      const st = await lstat(src);
      const sha = await sha256File(src);

      const dir = join(this.paths.libraryDir, category, title);
      await mkdir(dir, { recursive: true });
      const dest = await placeNoClobber(src, dir, data.date, fileExtension(name), sha);

      let id: number;
      try {
        id = this.db.transaction(() => {
          const now = new Date().toISOString();
          const categoryId = this.ensureCategory(category, now);
          const res = this.db
            .prepare(
              `INSERT INTO documents
                 (category_id, title, doc_date, rel_path, original_name, sha256, size, notes,
                  filed_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              categoryId,
              title,
              data.date,
              relative(this.paths.libraryDir, dest),
              name,
              sha,
              st.size,
              data.notes,
              now,
              now,
            );
          const docId = Number(res.lastInsertRowid);
          this.setTags(docId, data.tags);
          return docId;
        })();
      } catch (err) {
        await rm(dest, { force: true });
        await removeEmptyDirs(dir, this.paths.libraryDir);
        throw err;
      }

      await this.removeSource(src);
      this.hashCache.delete(name);
      return this.getDocument(id);
    });
  }

  /** Moves an inbox file to the discard folder (never deletes it). */
  discardItem(name: string): Promise<void> {
    return this.mutex.run(async () => {
      const src = await this.inboxFile(name);
      const st = await lstat(src);
      const sha = await sha256File(src);
      await mkdir(this.discardDir, { recursive: true });
      const ext = fileExtension(name);
      const base = ext ? name.slice(0, -ext.length) : name;
      const dest = await placeNoClobber(src, this.discardDir, base, ext, sha);
      try {
        this.db
          .prepare(
            `INSERT INTO discards (original_name, rel_path, sha256, size, discarded_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(name, relative(this.paths.dataDir, dest), sha, st.size, new Date().toISOString());
      } catch (err) {
        await rm(dest, { force: true });
        throw err;
      }
      await this.removeSource(src);
      this.hashCache.delete(name);
    });
  }

  // ---------------------------------------------------------------- documents

  listDocuments(query: DocumentQuery = {}): DocumentRecord[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.category) {
      where.push('c.name = ? COLLATE NOCASE');
      params.push(query.category);
    }
    if (query.tag) {
      where.push(`EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
                          WHERE dt.document_id = d.id AND t.name = ? COLLATE NOCASE)`);
      params.push(query.tag);
    }
    // Every whitespace-separated term must match somewhere (LIKE is case-insensitive for ASCII).
    const fields = ['d.title', 'd.notes', 'c.name', 'd.original_name', 'd.doc_date', 't.name'];
    for (const term of (query.q ?? '').split(/\s+/).filter(Boolean)) {
      const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      const match = (f: string) => `${f} LIKE ? ESCAPE '\\'`;
      where.push(`(${fields.slice(0, -1).map(match).join(' OR ')}
                   OR EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
                              WHERE dt.document_id = d.id AND ${match('t.name')}))`);
      params.push(...fields.map(() => like));
    }
    const sql = `${DOC_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY d.doc_date DESC, d.id DESC`;
    return this.toRecords(this.db.prepare(sql).all(...params) as DocumentRow[]);
  }

  getDocument(id: number): DocumentRecord {
    return this.toRecords([this.getRow(id)])[0]!;
  }

  async documentFile(id: number): Promise<string> {
    const path = join(this.paths.libraryDir, this.getRow(id).rel_path);
    if (!isInside(this.paths.libraryDir, path)) throw notFound('Document file not found');
    try {
      if ((await lstat(path)).isFile()) return path;
    } catch {
      // Fall through.
    }
    throw notFound('Document file is missing on disk');
  }

  /**
   * Metadata is authoritative; rel_path records where the file actually is. Updates write the
   * metadata first and then relocate the file, so an interrupted move leaves a valid (just
   * misplaced) record that `reorganize()` will finish.
   */
  updateDocument(id: number, input: UpdateDocumentInput): Promise<DocumentRecord> {
    return this.mutex.run(async () => {
      const row = this.getRow(id);
      const data = updateDocumentSchema.parse(input);
      const category = data.category ? this.canonicalCategory(data.category) : row.category;
      const title = data.title ? this.canonicalTitle(category, data.title, [id]) : row.title;
      const date = data.date ?? row.doc_date;
      const moving = category !== row.category || title !== row.title || date !== row.doc_date;
      // Don't record a move we already know can't happen.
      if (moving && !(await exists(join(this.paths.libraryDir, row.rel_path)))) {
        throw conflict(`Cannot move document ${id}: '${row.rel_path}' is missing from the library`);
      }
      this.db.transaction(() => {
        const now = new Date().toISOString();
        this.db
          .prepare(
            `UPDATE documents SET category_id = ?, title = ?, doc_date = ?, notes = ?,
               updated_at = ? WHERE id = ?`,
          )
          .run(this.ensureCategory(category, now), title, date, data.notes ?? row.notes, now, id);
        if (data.tags) this.setTags(id, data.tags);
        this.pruneOrphans();
      })();
      await this.relocate(id);
      return this.getDocument(id);
    });
  }

  /**
   * Renames a category, moving its folder contents. If `to` matches another existing category
   * (case-insensitively) the two are merged. A case-only change renames in place.
   */
  renameCategory(from: string, to: string): Promise<MoveReport> {
    return this.mutex.run(async () => {
      const src = this.db
        .prepare('SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE')
        .get(from) as { id: number; name: string } | undefined;
      if (!src) throw notFound(`Category '${from}' not found`);
      const newName = nameSchema('Category').parse(to);
      const other = this.db
        .prepare('SELECT id, name FROM categories WHERE name = ? COLLATE NOCASE AND id != ?')
        .get(newName, src.id) as { id: number; name: string } | undefined;
      const ids = this.idsWhere('category_id = ?', src.id);
      this.db.transaction(() => {
        if (other) {
          // Merge: adopt the target's existing title spellings so groups share folders.
          for (const id of ids) {
            const title = this.getRow(id).title;
            this.db
              .prepare(
                'UPDATE documents SET category_id = ?, title = ?, updated_at = ? WHERE id = ?',
              )
              .run(other.id, this.canonicalTitle(other.name, title, ids), nowIso(), id);
          }
          this.pruneOrphans();
        } else {
          this.db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(newName, src.id);
        }
      })();
      return this.relocateAll(ids);
    });
  }

  /** Retitles every document in a category/title group, optionally moving it to another category. */
  renameTitle(
    category: string,
    from: string,
    to: string,
    toCategory?: string,
  ): Promise<MoveReport> {
    return this.mutex.run(async () => {
      const ids = this.idsWhere(
        `category_id = (SELECT id FROM categories WHERE name = ? COLLATE NOCASE)
         AND title = ? COLLATE NOCASE`,
        category,
        from,
      );
      if (ids.length === 0) throw notFound(`No documents titled '${from}' in '${category}'`);
      const target = this.canonicalCategory(
        nameSchema('Category').parse(toCategory ?? this.getRow(ids[0]!).category),
      );
      const title = this.canonicalTitle(target, nameSchema('Title').parse(to), ids);
      this.db.transaction(() => {
        const now = nowIso();
        const categoryId = this.ensureCategory(target, now);
        const stmt = this.db.prepare(
          'UPDATE documents SET category_id = ?, title = ?, updated_at = ? WHERE id = ?',
        );
        for (const id of ids) stmt.run(categoryId, title, now, id);
        this.pruneOrphans();
      })();
      return this.relocateAll(ids);
    });
  }

  /** Moves every document whose file isn't at its canonical `<category>/<title>/<date>` path. */
  reorganize(): Promise<MoveReport> {
    return this.mutex.run(() => this.relocateAll(this.idsWhere('1 = 1')));
  }

  /** Compares the index with the library folder. Read-only. */
  async check(): Promise<CheckReport> {
    const rows = this.db.prepare(DOC_SELECT).all() as DocumentRow[];
    const tracked = new Set(rows.map((r) => r.rel_path));
    const missing: DocumentRecord[] = [];
    const misplaced: DocumentRecord[] = [];
    for (const row of rows) {
      try {
        await lstat(join(this.paths.libraryDir, row.rel_path));
      } catch {
        missing.push(this.toRecords([row])[0]!);
        continue;
      }
      if (!this.isCanonical(row)) misplaced.push(this.toRecords([row])[0]!);
    }
    const untracked = (await this.walkLibrary()).filter((p) => !tracked.has(p));
    return { missing, misplaced, untracked };
  }

  /**
   * Indexes untracked library files that sit at `<category>/<title>/<file>`. The date comes from a
   * leading YYYY-MM-DD in the filename, else the file's mtime. Other untracked files are skipped.
   */
  adoptUntracked(): Promise<{ adopted: DocumentRecord[]; skipped: string[] }> {
    return this.mutex.run(async () => {
      const { untracked } = await this.check();
      const adopted: DocumentRecord[] = [];
      const skipped: string[] = [];
      for (const rel of untracked) {
        const parts = rel.split('/');
        const [category, title, file] = parts;
        if (
          parts.length !== 3 ||
          !category ||
          !title ||
          !file ||
          sanitizeName(category) !== category ||
          sanitizeName(title) !== title
        ) {
          skipped.push(rel);
          continue;
        }
        const abs = join(this.paths.libraryDir, rel);
        const st = await lstat(abs);
        const prefix = /^(\d{4}-\d{2}-\d{2})/.exec(file)?.[1];
        const date = prefix && isValidIsoDate(prefix) ? prefix : localIsoDate(st.mtime);
        const sha = await sha256File(abs);
        const id = this.db.transaction(() => {
          const now = nowIso();
          const cat = this.canonicalCategory(category);
          const res = this.db
            .prepare(
              `INSERT INTO documents
                 (category_id, title, doc_date, rel_path, original_name, sha256, size, notes,
                  filed_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
            )
            .run(
              this.ensureCategory(cat, now),
              this.canonicalTitle(cat, title),
              date,
              rel,
              file,
              sha,
              st.size,
              now,
              now,
            );
          return Number(res.lastInsertRowid);
        })();
        adopted.push(this.getDocument(id));
      }
      return { adopted, skipped };
    });
  }

  categories(): CategorySummary[] {
    const rows = this.db
      .prepare(
        `SELECT c.name AS category, d.title AS title, COUNT(*) AS n
         FROM documents d JOIN categories c ON c.id = d.category_id
         GROUP BY c.id, d.title ORDER BY c.name COLLATE NOCASE, d.title COLLATE NOCASE`,
      )
      .all() as { category: string; title: string; n: number }[];
    const out = new Map<string, CategorySummary>();
    for (const r of rows) {
      let c = out.get(r.category);
      if (!c) out.set(r.category, (c = { name: r.category, count: 0, titles: [] }));
      c.count += r.n;
      c.titles.push(r.title);
    }
    return [...out.values()];
  }

  tags(): TagSummary[] {
    return this.db
      .prepare(
        `SELECT t.name AS name, COUNT(dt.document_id) AS count
         FROM tags t JOIN document_tags dt ON dt.tag_id = t.id
         GROUP BY t.id ORDER BY t.name COLLATE NOCASE`,
      )
      .all() as TagSummary[];
  }

  // ---------------------------------------------------------------- internals

  private async cachedHash(name: string, path: string, size: number, mtimeMs: number) {
    const hit = this.hashCache.get(name);
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.sha;
    const sha = await sha256File(path);
    this.hashCache.set(name, { size, mtimeMs, sha });
    return sha;
  }

  private findDuplicate(sha: string): Duplicate | null {
    const doc = this.db
      .prepare('SELECT id, rel_path FROM documents WHERE sha256 = ? LIMIT 1')
      .get(sha) as { id: number; rel_path: string } | undefined;
    if (doc) return { kind: 'document', id: doc.id, path: doc.rel_path };
    const discard = this.db
      .prepare('SELECT rel_path FROM discards WHERE sha256 = ? ORDER BY id DESC LIMIT 1')
      .get(sha) as { rel_path: string } | undefined;
    return discard ? { kind: 'discarded', path: discard.rel_path } : null;
  }

  /** Reuses an existing category's spelling when one matches case-insensitively. */
  private canonicalCategory(name: string): string {
    const row = this.db
      .prepare('SELECT name FROM categories WHERE name = ? COLLATE NOCASE')
      .get(name) as { name: string } | undefined;
    return row?.name ?? name;
  }

  /**
   * Reuses an existing title's spelling within the category so documents share one folder.
   * `excludeIds` are the documents being retitled (so a case-only change isn't undone).
   */
  private canonicalTitle(category: string, title: string, excludeIds: number[] = []): string {
    const row = this.db
      .prepare(
        `SELECT d.title FROM documents d JOIN categories c ON c.id = d.category_id
         WHERE c.name = ? COLLATE NOCASE AND d.title = ? COLLATE NOCASE
           AND d.id NOT IN (SELECT value FROM json_each(?)) LIMIT 1`,
      )
      .get(category, title, JSON.stringify(excludeIds)) as { title: string } | undefined;
    return row?.title ?? title;
  }

  private idsWhere(where: string, ...params: unknown[]): number[] {
    return (
      this.db.prepare(`SELECT id FROM documents WHERE ${where} ORDER BY id`).all(...params) as {
        id: number;
      }[]
    ).map((r) => r.id);
  }

  private isCanonical(row: DocumentRow): boolean {
    const ext = fileExtension(row.rel_path).replace('.', '\\.');
    const dir = join(row.category, row.title);
    return (
      dirname(row.rel_path) === dir &&
      new RegExp(`^${row.doc_date}( \\(\\d+\\))?${ext}$`).test(basename(row.rel_path))
    );
  }

  /** Moves a document's file to its canonical location. Returns the move, or null if none needed. */
  private async relocate(id: number): Promise<Move | null> {
    const row = this.getRow(id);
    if (this.isCanonical(row)) return null;
    const current = join(this.paths.libraryDir, row.rel_path);
    try {
      await lstat(current);
    } catch {
      throw conflict(`Cannot move document ${id}: '${row.rel_path}' is missing from the library`);
    }
    const dir = join(this.paths.libraryDir, row.category, row.title);
    await mkdir(dir, { recursive: true });
    const dest = await placeNoClobber(
      current,
      dir,
      row.doc_date,
      fileExtension(row.rel_path),
      row.sha256,
    );
    const to = relative(this.paths.libraryDir, dest);
    try {
      this.db.prepare('UPDATE documents SET rel_path = ? WHERE id = ?').run(to, id);
    } catch (err) {
      await rm(dest, { force: true });
      await removeEmptyDirs(dir, this.paths.libraryDir);
      throw err;
    }
    await this.removeSource(current);
    await removeEmptyDirs(dirname(current), this.paths.libraryDir);
    return { id, from: row.rel_path, to };
  }

  /** Relocates each document, continuing past failures so one bad file doesn't block the rest. */
  private async relocateAll(ids: number[]): Promise<MoveReport> {
    const report: MoveReport = { moved: [], failed: [] };
    for (const id of ids) {
      try {
        const move = await this.relocate(id);
        if (move) report.moved.push(move);
      } catch (err) {
        report.failed.push({ id, error: (err as Error).message });
      }
    }
    return report;
  }

  /** Relative paths of all files in the library, excluding dotfiles/dirs (e.g. .wcdocmanager). */
  private async walkLibrary(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (rel: string) => {
      let entries;
      try {
        entries = await readdir(join(this.paths.libraryDir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.')) continue;
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(child);
        else if (e.isFile()) out.push(child);
      }
    };
    await walk('');
    return out.sort();
  }

  private ensureCategory(name: string, now: string): number {
    this.db
      .prepare('INSERT INTO categories (name, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING')
      .run(name, now);
    return (
      this.db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name) as {
        id: number;
      }
    ).id;
  }

  private setTags(docId: number, tags: string[]) {
    this.db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(docId);
    const insertTag = this.db.prepare('INSERT INTO tags (name) VALUES (?) ON CONFLICT DO NOTHING');
    const getTag = this.db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE');
    const link = this.db.prepare('INSERT INTO document_tags (document_id, tag_id) VALUES (?, ?)');
    for (const tag of tags) {
      insertTag.run(tag);
      link.run(docId, (getTag.get(tag) as { id: number }).id);
    }
    this.pruneOrphans();
  }

  private pruneOrphans() {
    this.db.exec(`
      DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM document_tags);
      DELETE FROM categories WHERE id NOT IN (SELECT category_id FROM documents);
    `);
  }

  private getRow(id: number): DocumentRow {
    const row = this.db.prepare(`${DOC_SELECT} WHERE d.id = ?`).get(id) as DocumentRow | undefined;
    if (!row) throw notFound(`Document ${id} not found`);
    return row;
  }

  private toRecords(rows: DocumentRow[]): DocumentRecord[] {
    if (rows.length === 0) return [];
    const tagRows = this.db
      .prepare(
        `SELECT dt.document_id AS id, t.name AS name
         FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
         WHERE dt.document_id IN (SELECT value FROM json_each(?))
         ORDER BY t.name COLLATE NOCASE`,
      )
      .all(JSON.stringify(rows.map((r) => r.id))) as { id: number; name: string }[];
    const tagsById = new Map<number, string[]>();
    for (const t of tagRows) {
      const list = tagsById.get(t.id) ?? [];
      list.push(t.name);
      tagsById.set(t.id, list);
    }
    return rows.map((r) => ({
      id: r.id,
      category: r.category,
      title: r.title,
      date: r.doc_date,
      path: r.rel_path,
      originalName: r.original_name,
      sha256: r.sha256,
      size: r.size,
      notes: r.notes,
      tags: tagsById.get(r.id) ?? [],
      filedAt: r.filed_at,
      updatedAt: r.updated_at,
    }));
  }

  private async removeSource(path: string) {
    try {
      await unlink(path);
    } catch (err) {
      // The new copy is recorded; a leftover source shows up as a duplicate rather than being lost.
      this.log.warn({ err, path }, 'filed copy recorded but source could not be removed');
    }
  }
}
