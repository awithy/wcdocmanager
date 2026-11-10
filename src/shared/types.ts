import { z } from 'zod';
import { isValidIsoDate, MAX_NAME_LENGTH, normalizeTags, sanitizeName } from './names';

export const nameSchema = (label: string) =>
  z
    .string()
    .max(MAX_NAME_LENGTH * 2)
    .transform(sanitizeName)
    .refine((s) => s.length > 0, `${label} is required`);

const dateField = z.string().refine(isValidIsoDate, 'Date must be a valid YYYY-MM-DD date');
const tagsField = z.array(z.string()).max(50).transform(normalizeTags);
const notesField = z.string().max(20_000);

export const fileInputSchema = z.object({
  category: nameSchema('Category'),
  title: nameSchema('Title'),
  date: dateField,
  tags: tagsField.default([]),
  notes: notesField.default(''),
});
export type FileInput = z.input<typeof fileInputSchema>;

export const updateDocumentSchema = z.object({
  category: nameSchema('Category').optional(),
  title: nameSchema('Title').optional(),
  date: dateField.optional(),
  tags: tagsField.optional(),
  notes: notesField.optional(),
});
export type UpdateDocumentInput = z.input<typeof updateDocumentSchema>;

export type Duplicate =
  { kind: 'document'; id: number; path: string } | { kind: 'discarded'; path: string };

export interface InboxItem {
  name: string;
  size: number;
  /** ISO timestamp of the file's mtime (adb pull -a preserves the device timestamp). */
  modifiedAt: string;
  /** Local date of mtime, used as the default document date. */
  suggestedDate: string;
  sha256: string;
  duplicate: Duplicate | null;
}

export interface DocumentRecord {
  id: number;
  category: string;
  title: string;
  date: string;
  /** Relative to the library root. */
  path: string;
  originalName: string;
  sha256: string;
  size: number;
  notes: string;
  tags: string[];
  filedAt: string;
  updatedAt: string;
}

export interface CategorySummary {
  name: string;
  count: number;
  titles: string[];
}

export interface TagSummary {
  name: string;
  count: number;
}

export interface Settings {
  inboxDir: string;
  libraryDir: string;
  importEnabled: boolean;
}

export interface ImportResult {
  ok: boolean;
  output: string;
}

export interface Move {
  id: number;
  from: string;
  to: string;
}

export interface MoveReport {
  moved: Move[];
  failed: { id: number; error: string }[];
}

export interface CheckReport {
  /** Indexed, but the file is gone. */
  missing: DocumentRecord[];
  /** File exists but not at its canonical path (fix with reorganize). */
  misplaced: DocumentRecord[];
  /** Files in the library tree with no index entry (relative paths). */
  untracked: string[];
}
