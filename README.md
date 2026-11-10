# wcdocmanager

Local, single-user app for filing scanned documents. Scans land in an inbox folder
(`~/personal/scans`, filled by `~/personal/pull-downloads.sh`); you give each one a category,
title, date, tags and notes, and it is moved into the library:

```
~/personal/documents/
├── Utilities/
│   └── Electricity Bill/
│       ├── 2026-10-02.pdf
│       └── 2026-11-03.pdf
├── Tax/
│   └── Federal Return/
│       └── 2026-04-15.pdf
└── .wcdocmanager/          # app data: index.sqlite + discarded/
```

The folder tree is meant to be useful without the app. SQLite indexes it and holds the extra
metadata (tags, notes, original filename, hash).

## Usage

```sh
pnpm install
pnpm build && pnpm start       # http://127.0.0.1:4317
pnpm dev                       # API on :4317 + Vite on http://127.0.0.1:5173
pnpm cli:install               # installs ~/.local/bin/wcdoc
wcdoc --help
```

Configuration is via environment or `.env` (see `.env.example`): `INBOX_DIR`, `LIBRARY_DIR`,
`DATA_DIR`, `PULL_SCRIPT` (empty disables the Import button), `HOST`, `PORT`.

## Web UI

- **Inbox**: oldest scan first. Category → Title → Date (defaults to the scan's timestamp) →
  Tags → Notes, then **Ctrl+Enter** to file; the next scan loads. **Discard** moves the scan to
  `.wcdocmanager/discarded/` (nothing is deleted). Scans identical to an already filed or discarded
  file are flagged. **Import from phone** runs the pull script.
- **Library**: search (every term must match title/notes/category/tags/date/original name),
  filter by category or tag, edit any field (the file moves to match), rename/merge a category,
  retitle a whole title group, and check the library against the index.

## CLI

`wcdoc` works directly on the index and folders, so the server doesn't need to be running.

```sh
wcdoc inbox
wcdoc file scan_123.pdf -c Utilities -t "Electricity Bill" --tag power
wcdoc ls electricity            # search
wcdoc edit 12 -t "Water Bill" --add-tag paid
wcdoc rename-category Bills Utilities          # merges if Utilities exists
wcdoc rename-title Home Insurance "Home Insurance" --to-category Insurance
wcdoc check                     # missing / misplaced / untracked files
wcdoc reorganize [--dry-run]    # move misplaced files to their canonical paths
wcdoc adopt                     # index files added to <category>/<title>/ by hand
wcdoc open 12
```

## Rules

- Category and title are folder names: `/ \ : * ? " < > |` and control characters become `-`,
  leading dots are stripped, max 100 chars. They match existing names case-insensitively and
  reuse the existing spelling.
- Files are named `<date>.<ext>`; collisions get ` (2)`, ` (3)`, … Nothing is ever overwritten
  (files are placed with `link(2)`, falling back to an exclusive, hash-verified copy).
- Metadata is authoritative. Edits update the index, then move the file. If a move is
  interrupted the record still points at the real file, and `wcdoc check` / `reorganize` will
  finish it.
- No auth. The server binds to 127.0.0.1 and rejects requests with a non-local `Host` or a
  cross-site `Origin`, so other web pages in your browser can't drive it.
