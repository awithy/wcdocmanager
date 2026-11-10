import { useCallback, useEffect, useState } from 'react';
import { fileExtension, formatSize } from '../shared/names';
import type { InboxItem } from '../shared/types';
import { api } from './api';
import type { Meta, Notify } from './App';
import { DocForm, type DocFormValues } from './DocForm';

interface Props {
  meta: Meta;
  notify: Notify;
  importEnabled: boolean;
  onCount: (n: number) => void;
}

export function Inbox({ meta, notify, importEnabled, onCount }: Props) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importLog, setImportLog] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await api.inbox();
      setItems(list);
      onCount(list.length);
      setSelected((cur) =>
        cur && list.some((i) => i.name === cur) ? cur : (list[0]?.name ?? null),
      );
      return list;
    } catch (e) {
      notify((e as Error).message, 'error');
      return null;
    }
  }, [notify, onCount]);

  // Pick up new scans: on load, when the window regains focus, and every 10s.
  useEffect(() => {
    void refresh();
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    const timer = setInterval(
      () => document.visibilityState === 'visible' && void refresh(),
      10_000,
    );
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(timer);
    };
  }, [refresh]);

  const item = items?.find((i) => i.name === selected) ?? null;

  /** Removes the current item and selects the one that followed it. */
  const advance = async (name: string) => {
    const index = items?.findIndex((i) => i.name === name) ?? -1;
    const list = await refresh();
    if (list) setSelected(list[Math.min(index, list.length - 1)]?.name ?? null);
  };

  const onFile = async (values: DocFormValues) => {
    if (!item) return;
    setBusy(true);
    try {
      const doc = await api.fileItem(item.name, values);
      notify(`Filed → ${doc.path}`);
      await meta.refresh();
      await advance(item.name);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onDiscard = async () => {
    if (!item || !confirm(`Discard ${item.name}? It will be moved to the discard folder.`)) return;
    setBusy(true);
    try {
      await api.discard(item.name);
      notify(`Discarded ${item.name}`);
      await advance(item.name);
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const onImport = async () => {
    setImporting(true);
    try {
      const result = await api.import();
      setImportLog(result.output.trim() || '(no output)');
      notify(result.ok ? 'Import finished' : 'Import failed', result.ok ? 'info' : 'error');
      await refresh();
    } catch (e) {
      notify((e as Error).message, 'error');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="workspace">
      <aside className="sidebar">
        <div className="sidebar-head">
          <strong>Queue {items ? `(${items.length})` : ''}</strong>
          <div className="row">
            <button onClick={() => void refresh()} title="Rescan the inbox folder">
              ↻
            </button>
            {importEnabled && (
              <button onClick={onImport} disabled={importing} title="Run the phone pull script">
                {importing ? 'Importing…' : 'Import from phone'}
              </button>
            )}
          </div>
        </div>
        {importLog !== null && (
          <pre className="import-log" onClick={() => setImportLog(null)} title="Click to dismiss">
            {importLog}
          </pre>
        )}
        <ul className="list">
          {items?.map((i) => (
            <li
              key={i.name}
              className={i.name === selected ? 'selected' : ''}
              onClick={() => setSelected(i.name)}
            >
              <div className="name">{i.name}</div>
              <div className="sub">
                {i.suggestedDate} · {formatSize(i.size)}
                {i.duplicate && <span className="warn"> · duplicate</span>}
              </div>
            </li>
          ))}
        </ul>
        {items?.length === 0 && <p className="empty">Inbox is empty. Nice.</p>}
      </aside>

      <section className="preview">
        {item ? (
          <iframe key={item.name} title={item.name} src={api.inboxContentUrl(item.name)} />
        ) : (
          <p className="empty">Nothing to file.</p>
        )}
      </section>

      <aside className="details">
        {item && (
          <>
            <h2 className="filename" title={item.name}>
              {item.name}
            </h2>
            {item.duplicate && (
              <div className="banner warn">
                {item.duplicate.kind === 'document' ? (
                  <>
                    Identical to filed document{' '}
                    <a href={`#/library/${item.duplicate.id}`}>{item.duplicate.path}</a>
                  </>
                ) : (
                  <>Identical to a previously discarded scan ({item.duplicate.path})</>
                )}
              </div>
            )}
            <DocForm
              key={item.name}
              initial={{ category: '', title: '', date: item.suggestedDate, tags: [], notes: '' }}
              ext={fileExtension(item.name)}
              categories={meta.categories}
              tags={meta.tags}
              submitLabel="File"
              busy={busy}
              onSubmit={onFile}
              autoFocus
              actions={
                <button type="button" className="danger" onClick={onDiscard} disabled={busy}>
                  Discard
                </button>
              }
            />
          </>
        )}
      </aside>
    </div>
  );
}
