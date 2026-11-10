import { useCallback, useEffect, useState } from 'react';
import type { CategorySummary, Settings, TagSummary } from '../shared/types';
import { api } from './api';
import { Inbox } from './Inbox';
import { Library } from './Library';

export interface Meta {
  categories: CategorySummary[];
  tags: TagSummary[];
  refresh: () => Promise<void>;
}

export type Notify = (message: string, kind?: 'info' | 'error') => void;

interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'error';
}

function useHashRoute() {
  const parse = () => window.location.hash.replace(/^#\/?/, '').split('/');
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const onChange = () => setRoute(parse());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export function App() {
  const route = useHashRoute();
  const view = route[0] === 'library' ? 'library' : 'inbox';
  const docId = view === 'library' && route[1] ? Number(route[1]) : null;

  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<CategorySummary[]>([]);
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [inboxCount, setInboxCount] = useState<number | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify: Notify = useCallback((message, kind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      kind === 'error' ? 8000 : 4000,
    );
  }, []);

  const refreshMeta = useCallback(async () => {
    const [c, t] = await Promise.all([api.categories(), api.tags()]);
    setCategories(c);
    setTags(t);
  }, []);

  useEffect(() => {
    api.settings().then(setSettings, (e: Error) => notify(e.message, 'error'));
    refreshMeta().catch((e: Error) => notify(e.message, 'error'));
  }, [notify, refreshMeta]);

  const meta: Meta = { categories, tags, refresh: refreshMeta };

  return (
    <div className="app">
      <header>
        <h1>wcdocmanager</h1>
        <nav>
          <a href="#/inbox" className={view === 'inbox' ? 'active' : ''}>
            Inbox{inboxCount ? <span className="badge">{inboxCount}</span> : null}
          </a>
          <a href="#/library" className={view === 'library' ? 'active' : ''}>
            Library
          </a>
        </nav>
        {settings && (
          <span className="paths" title="Inbox → Library">
            {settings.inboxDir} → {settings.libraryDir}
          </span>
        )}
      </header>
      <main>
        {view === 'inbox' ? (
          <Inbox
            meta={meta}
            notify={notify}
            importEnabled={settings?.importEnabled ?? false}
            onCount={setInboxCount}
          />
        ) : (
          <Library meta={meta} notify={notify} selectedId={docId} />
        )}
      </main>
      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
