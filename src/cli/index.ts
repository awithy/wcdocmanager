import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { z } from 'zod';
import { formatSize } from '../shared/names';
import type { DocumentRecord, MoveReport } from '../shared/types';
import { loadConfig } from '../server/config';
import { openLibrary } from '../server/context';
import { HttpError } from '../server/errors';
import { runImport } from '../server/importer';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const envFile = join(projectRoot, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const HELP = `wcdoc — manage the scanned document library

Inbox
  inbox [--json]                         List scans waiting to be filed (oldest first)
  file <name> -c CAT -t TITLE [-d DATE] [--tag T]... [--notes TEXT]
                                         File a scan (date defaults to the scan's date)
  discard <name>                         Move a scan to the discard folder
  import                                 Run the phone pull script

Library
  ls [QUERY...] [-c CAT] [--tag T] [--json]
                                         List/search documents (every term must match)
  show <id> [--json]                     Show one document
  path <id>                              Print the document's absolute path
  open <id>                              Open the document with xdg-open
  edit <id> [-c CAT] [-t TITLE] [-d DATE] [--notes TEXT]
            [--tag T]... | [--add-tag T]... [--remove-tag T]... | [--clear-tags]
                                         Change info; the file moves to match
  categories [--json]                    List categories with their titles
  tags [--json]                          List tags

Reorganize
  rename-category <from> <to>            Rename (or merge into an existing) category
  rename-title <category> <from> <to> [--to-category CAT]
                                         Retitle a whole title group, optionally moving it
  check [--json]                         Report missing, misplaced and untracked files
  reorganize [--dry-run]                 Move misplaced files to their canonical paths
  adopt                                  Index untracked files found at <category>/<title>/<file>

Dates are YYYY-MM-DD. Names match existing categories/titles case-insensitively.
Paths come from ${envFile} or the environment (INBOX_DIR, LIBRARY_DIR, DATA_DIR, PULL_SCRIPT).`;

class UsageError extends Error {}

const options = {
  json: { type: 'boolean' },
  category: { type: 'string', short: 'c' },
  title: { type: 'string', short: 't' },
  date: { type: 'string', short: 'd' },
  notes: { type: 'string' },
  tag: { type: 'string', multiple: true },
  'add-tag': { type: 'string', multiple: true },
  'remove-tag': { type: 'string', multiple: true },
  'clear-tags': { type: 'boolean' },
  'to-category': { type: 'string' },
  'dry-run': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} satisfies ParseArgsConfig['options'];

const { values: opts, positionals } = (() => {
  try {
    return parseArgs({ options, allowPositionals: true });
  } catch (err) {
    console.error(`${(err as Error).message}\n\nRun 'wcdoc --help' for usage.`);
    process.exit(2);
  }
})();

const [command, ...args] = positionals;
if (!command || opts.help || command === 'help') {
  console.log(HELP);
  process.exit(command || opts.help ? 0 : 2);
}

const config = loadConfig();
const { db, library } = openLibrary(config, {
  warn: (obj, msg) => console.error(`warning: ${msg}`, obj),
});

function arg(i: number, label: string): string {
  const v = args[i];
  if (v === undefined) throw new UsageError(`Missing <${label}>`);
  return v;
}

function idArg(): number {
  const id = Number(arg(0, 'id'));
  if (!Number.isInteger(id) || id <= 0) throw new UsageError('<id> must be a positive integer');
  return id;
}

function print(value: unknown, human: () => void) {
  if (opts.json) console.log(JSON.stringify(value, null, 2));
  else human();
}

function docLine(d: DocumentRecord): string {
  const tags = d.tags.length ? `  [${d.tags.join(', ')}]` : '';
  return `${String(d.id).padStart(5)}  ${d.date}  ${d.category} / ${d.title}${tags}`;
}

function docDetail(d: DocumentRecord) {
  console.log(
    [
      `id:        ${d.id}`,
      `category:  ${d.category}`,
      `title:     ${d.title}`,
      `date:      ${d.date}`,
      `tags:      ${d.tags.join(', ') || '-'}`,
      `path:      ${join(config.libraryDir, d.path)}`,
      `original:  ${d.originalName}`,
      `size:      ${formatSize(d.size)}`,
      `filed:     ${d.filedAt}`,
      `updated:   ${d.updatedAt}`,
      `sha256:    ${d.sha256}`,
      ...(d.notes ? ['notes:', ...d.notes.split('\n').map((l) => `  ${l}`)] : []),
    ].join('\n'),
  );
}

function moveReport(report: MoveReport) {
  print(report, () => {
    for (const m of report.moved) console.log(`moved ${m.id}: ${m.from} -> ${m.to}`);
    for (const f of report.failed) console.error(`FAILED ${f.id}: ${f.error}`);
    console.log(`${report.moved.length} moved, ${report.failed.length} failed`);
  });
  if (report.failed.length) process.exitCode = 1;
}

const ignore = () => {};

const commands: Record<string, () => Promise<void> | void> = {
  async inbox() {
    const items = await library.listInbox();
    print(items, () => {
      if (!items.length) return console.log('Inbox is empty.');
      for (const i of items) {
        const dup = i.duplicate
          ? `  (duplicate of ${i.duplicate.kind === 'document' ? `#${i.duplicate.id} ` : 'discarded '}${i.duplicate.path})`
          : '';
        console.log(`${i.suggestedDate}  ${formatSize(i.size).padStart(8)}  ${i.name}${dup}`);
      }
    });
  },

  async file() {
    const name = arg(0, 'name');
    if (!opts.category || !opts.title)
      throw new UsageError('file requires -c CATEGORY and -t TITLE');
    const item = (await library.listInbox()).find((i) => i.name === name);
    if (!item) throw new HttpError(404, `'${name}' is not in the inbox`);
    const doc = await library.fileItem(name, {
      category: opts.category,
      title: opts.title,
      date: opts.date ?? item.suggestedDate,
      tags: opts.tag ?? [],
      notes: opts.notes ?? '',
    });
    print(doc, () => console.log(`Filed #${doc.id} -> ${doc.path}`));
  },

  async discard() {
    const name = arg(0, 'name');
    await library.discardItem(name);
    console.log(`Discarded ${name} (moved to ${library.discardDir})`);
  },

  async import() {
    if (!config.pullScript) throw new UsageError('Import is disabled (PULL_SCRIPT is empty)');
    const result = await runImport(config.pullScript);
    process.stdout.write(result.output);
    if (!result.ok) process.exitCode = 1;
  },

  ls() {
    const docs = library.listDocuments({
      q: args.join(' '),
      category: opts.category,
      tag: opts.tag?.[0],
    });
    print(docs, () => {
      for (const d of docs) console.log(docLine(d));
      console.error(`${docs.length} document(s)`);
    });
  },

  show() {
    const doc = library.getDocument(idArg());
    print(doc, () => docDetail(doc));
  },

  async path() {
    console.log(await library.documentFile(idArg()));
  },

  async open() {
    const path = await library.documentFile(idArg());
    spawn('xdg-open', [path], { detached: true, stdio: 'ignore' }).on('error', ignore).unref();
  },

  async edit() {
    const id = idArg();
    const current = library.getDocument(id);
    const replacing = opts.tag !== undefined || opts['clear-tags'];
    const adjusting = opts['add-tag'] !== undefined || opts['remove-tag'] !== undefined;
    if (replacing && adjusting) {
      throw new UsageError('Use either --tag/--clear-tags (replace) or --add-tag/--remove-tag');
    }
    let tags: string[] | undefined;
    if (replacing) tags = opts.tag ?? [];
    if (adjusting) {
      const remove = new Set((opts['remove-tag'] ?? []).map((t) => t.toLowerCase()));
      tags = [...current.tags, ...(opts['add-tag'] ?? [])].filter(
        (t) => !remove.has(t.toLowerCase()),
      );
    }
    const input = {
      category: opts.category,
      title: opts.title,
      date: opts.date,
      notes: opts.notes,
      tags,
    };
    if (Object.values(input).every((v) => v === undefined)) {
      throw new UsageError('Nothing to change; pass -c, -t, -d, --notes or tag options');
    }
    const doc = await library.updateDocument(id, input);
    print(doc, () => {
      if (doc.path !== current.path) console.log(`moved: ${current.path} -> ${doc.path}`);
      docDetail(doc);
    });
  },

  categories() {
    const cats = library.categories();
    print(cats, () => {
      for (const c of cats) {
        console.log(`${c.name} (${c.count})`);
        for (const t of c.titles) console.log(`  ${t}`);
      }
    });
  },

  tags() {
    const tags = library.tags();
    print(tags, () => tags.forEach((t) => console.log(`${t.name} (${t.count})`)));
  },

  async 'rename-category'() {
    moveReport(await library.renameCategory(arg(0, 'from'), arg(1, 'to')));
  },

  async 'rename-title'() {
    moveReport(
      await library.renameTitle(
        arg(0, 'category'),
        arg(1, 'from'),
        arg(2, 'to'),
        opts['to-category'],
      ),
    );
  },

  async check() {
    const report = await library.check();
    print(report, () => {
      for (const d of report.missing) console.log(`missing    #${d.id}  ${d.path}`);
      for (const d of report.misplaced) {
        console.log(`misplaced  #${d.id}  ${d.path}  (should be under ${d.category}/${d.title}/)`);
      }
      for (const p of report.untracked) console.log(`untracked  ${p}`);
      const { missing, misplaced, untracked } = report;
      console.log(
        `${missing.length} missing, ${misplaced.length} misplaced, ${untracked.length} untracked`,
      );
      if (misplaced.length) console.log("Run 'wcdoc reorganize' to move misplaced files.");
      if (untracked.length) console.log("Run 'wcdoc adopt' to index untracked files.");
    });
    if (report.missing.length) process.exitCode = 1;
  },

  async reorganize() {
    if (opts['dry-run']) {
      const { misplaced } = await library.check();
      print(misplaced, () => {
        for (const d of misplaced)
          console.log(`would move #${d.id}: ${d.path} -> ${d.category}/${d.title}/`);
        console.log(`${misplaced.length} document(s) would move`);
      });
      return;
    }
    moveReport(await library.reorganize());
  },

  async adopt() {
    const { adopted, skipped } = await library.adoptUntracked();
    print({ adopted, skipped }, () => {
      for (const d of adopted) console.log(`adopted ${docLine(d).trim()}`);
      for (const p of skipped) console.log(`skipped ${p} (not at <category>/<title>/<file>)`);
      console.log(`${adopted.length} adopted, ${skipped.length} skipped`);
      if (adopted.length) console.log("Run 'wcdoc reorganize' to rename adopted files by date.");
    });
  },
};

try {
  const run = commands[command];
  if (!run) throw new UsageError(`Unknown command '${command}'`);
  await run();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`${err.message}\n\nRun 'wcdoc --help' for usage.`);
    process.exitCode = 2;
  } else if (err instanceof z.ZodError) {
    console.error(`error: ${err.issues.map((i) => i.message).join('; ')}`);
    process.exitCode = 1;
  } else if (err instanceof HttpError) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
} finally {
  db.close();
}
