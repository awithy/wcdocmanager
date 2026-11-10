/**
 * Name rules shared by server (authoritative) and web (path previews).
 *
 * Category and title names double as directory names, so the stored name is always the
 * sanitized form. Characters that are illegal on common filesystems are replaced so the
 * library can be copied to non-Linux disks/backups unchanged.
 */

export const MAX_NAME_LENGTH = 100;
export const MAX_TAG_LENGTH = 40;

const ILLEGAL = /[/\\:*?"<>|\u0000-\u001f\u007f]/g;

/** Returns the directory-safe form of a category or title, or '' if nothing usable remains. */
export function sanitizeName(input: string): string {
  let s = input.normalize('NFC').replace(ILLEGAL, '-').replace(/\s+/g, ' ').trim();
  // No hidden directories (also keeps clear of the app's .wcdocmanager data dir), no '.'/'..'.
  s = s.replace(/^[.\s]+/, '');
  if (s.length > MAX_NAME_LENGTH) s = s.slice(0, MAX_NAME_LENGTH);
  // Windows-hostile trailing dots/spaces.
  s = s.replace(/[.\s]+$/, '');
  return s;
}

export function normalizeTag(input: string): string {
  return input.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, MAX_TAG_LENGTH).trim();
}

/** Dedupes case-insensitively, keeping the first spelling. */
export function normalizeTags(input: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    const tag = normalizeTag(raw);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      out.push(tag);
    }
  }
  return out;
}

export function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Local-time YYYY-MM-DD. */
export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fileExtension(name: string): string {
  const m = /\.[A-Za-z0-9]{1,8}$/.exec(name);
  return m ? m[0].toLowerCase() : '';
}

/** Library path (relative) a document would get, ignoring collision suffixes. */
export function previewRelPath(category: string, title: string, date: string, ext: string) {
  return `${sanitizeName(category) || '?'}/${sanitizeName(title) || '?'}/${date || '?'}${ext}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
