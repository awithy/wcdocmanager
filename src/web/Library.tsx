import { useCallback, useEffect, useState } from 'react';
import { fileExtension, formatSize } from '../shared/names';
import type { DocumentRecord, MoveReport } from '../shared/types';
import { api } from './api';
import type { Meta, Notify } from './App';
import { DocForm, type DocFormValues } from './DocForm';

interface Props {
  meta: Meta;
  notify: Notify;
  selectedId: number | null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const select = (id: number | null) => {
  window.location.hash = id ? `#/library/${id}` : '#/library';
};

export function Library({ meta, notify, selectedId }: Props) {
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [tag, setTag] = useState('');
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null);
  const [doc, setDoc] = useState<DocumentRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const query = useDebounced(q, 200);

  const loadList = useCallback(async () => {
    try {
      setDocs(await api.documents({ q: query, category, tag }));
    } catch (e) {
      notify((e as Error).message, 'error');
    }
  }, [query, category, tag, notify]);

  useEffect(() => void loadList(), [loadList]);

  useEffect(() => {
    if (!selectedId) return setDoc(null);
    api.document(selectedId).then(setDoc, (e: Error) => {
      notify(e.message, 'error');
      setDoc(null);
    });
  }, [selectedId, notify]);

  const afterChange = async () => {
    await Promise.all([meta.refresh(), loadList()]);
    if (selectedId) setDoc(await api.document(selectedId).catch(() => null));
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const reportMoves = (r: MoveReport) => {
    notify(`${r.moved.length} file(s) moved`);
    for (const f of r.failed) notify(`#${f.id}: ${f.error}`, 'error');
  };

  const onSave = (values: DocFormValues) =>
    run(async () => {
      if (!doc) return;
      const updated = await api.updateDocument(doc.id, values);
      notify(updated.path === doc.path ? 'Saved' : `Saved and moved → ${updated.path}`);
      await afterChange();
    });

  const onRenameCategory = () => {
    if (!doc) return;
    const to = prompt(
      `Rename category "${doc.category}" (all its documents move).\nUse an existing name to merge.`,
      doc.category,
    );
    if (!to || to === doc.category) return;
    void run(async () => {
      reportMoves(await api.renameCategory(doc.category, to));
      if (category) setCategory('');
      await afterChange();
    });
  };

  const onRenameTitle = () => {
    if (!doc) return;
    const to = prompt(`Retitle every "${doc.title}" document in ${doc.category}:`, doc.title);
    if (!to || to === doc.title) return;
    void run(async () => {
      reportMoves(await api.renameTitle(doc.category, doc.title, to));
      await afterChange();
    });
  };

  const onCheck = () =>
    run(async () => {
      const r = await api.check();
      const summary = `${r.missing.length} missing, ${r.misplaced.length} misplaced, ${r.untracked.length} untracked`;
      notify(summary, r.missing.length ? 'error' : 'info');
      for (const d of r.missing) notify(`Missing #${d.id}: ${d.path}`, 'error');
      if (r.untracked.length) {
        notify(`Untracked files exist; run 'wcdoc check' / 'wcdoc adopt' to review`);
      }
      if (
        r.misplaced.length &&
        confirm(`${r.misplaced.length} file(s) are misplaced. Move them now?`)
      ) {
        reportMoves(await api.reorganize());
        await afterChange();
      }
    });

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="filters">
          <input
            type="search"
            placeholder="Search title, notes, tags…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
          <div className="row">
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All categories</option>
              {meta.categories.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
            <select value={tag} onChange={(e) => setTag(e.target.value)}>
              <option value="">All tags</option>
              {meta.tags.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.count})
                </option>
              ))}
            </select>
          </div>
          <div className="row spread">
            <span className="sub">{docs ? `${docs.length} document(s)` : ''}</span>
            <button onClick={onCheck} disabled={busy} title="Compare the index with the folders">
              Check library
            </button>
          </div>
        </div>
        <ul className="list">
          {docs?.map((d) => (
            <li
              key={d.id}
              className={d.id === selectedId ? 'selected' : ''}
              onClick={() => select(d.id)}
            >
              <div className="name">{d.title}</div>
              <div className="sub">
                {d.date} · {d.category}
                {d.tags.length > 0 && ` · ${d.tags.join(', ')}`}
              </div>
            </li>
          ))}
        </ul>
        {docs?.length === 0 && <p className="empty">No documents match.</p>}
      </aside>

      <section className="preview">
        {doc ? (
          <iframe
            key={`${doc.id}:${doc.path}`}
            title={doc.title}
            src={api.documentContentUrl(doc.id, doc.path)}
          />
        ) : (
          <p className="empty">Select a document.</p>
        )}
      </section>

      <aside className="details">
        {doc && (
          <>
            <h2 className="filename" title={doc.path}>
              {doc.path}
            </h2>
            <DocForm
              key={`${doc.id}:${doc.updatedAt}`}
              initial={{
                category: doc.category,
                title: doc.title,
                date: doc.date,
                tags: doc.tags,
                notes: doc.notes,
              }}
              ext={fileExtension(doc.path)}
              categories={meta.categories}
              tags={meta.tags}
              submitLabel="Save"
              busy={busy}
              onSubmit={onSave}
            />
            <div className="reorg">
              <button onClick={onRenameCategory} disabled={busy}>
                Rename category…
              </button>
              <button onClick={onRenameTitle} disabled={busy}>
                Retitle group…
              </button>
            </div>
            <dl className="facts">
              <dt>Original</dt>
              <dd>{doc.originalName}</dd>
              <dt>Size</dt>
              <dd>{formatSize(doc.size)}</dd>
              <dt>Filed</dt>
              <dd>{new Date(doc.filedAt).toLocaleString()}</dd>
              <dt>ID</dt>
              <dd>{doc.id}</dd>
            </dl>
          </>
        )}
      </aside>
    </div>
  );
}
