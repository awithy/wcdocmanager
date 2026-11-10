import { useId, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { normalizeTags, previewRelPath } from '../shared/names';
import type { CategorySummary, TagSummary } from '../shared/types';

export interface DocFormValues {
  category: string;
  title: string;
  date: string;
  tags: string[];
  notes: string;
}

interface Props {
  initial: DocFormValues;
  /** File extension, for the destination preview. */
  ext: string;
  categories: CategorySummary[];
  tags: TagSummary[];
  submitLabel: string;
  busy: boolean;
  onSubmit: (values: DocFormValues) => void;
  /** Rendered next to the submit button. */
  actions?: ReactNode;
  autoFocus?: boolean;
}

/** Shared by filing (inbox) and editing (library). Ctrl/Cmd+Enter submits. */
export function DocForm({
  initial,
  ext,
  categories,
  tags,
  submitLabel,
  busy,
  onSubmit,
  actions,
  autoFocus,
}: Props) {
  const [values, setValues] = useState(initial);
  const [tagDraft, setTagDraft] = useState('');
  const ids = { cats: useId(), titles: useId(), tags: useId() };

  const set = <K extends keyof DocFormValues>(key: K, value: DocFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));

  const titles =
    categories.find((c) => c.name.toLowerCase() === values.category.trim().toLowerCase())?.titles ??
    [];

  const withDraft = () => normalizeTags([...values.tags, ...tagDraft.split(',')]);

  const commitDraft = () => {
    if (!tagDraft.trim()) return;
    set('tags', withDraft());
    setTagDraft('');
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    const tagsNow = withDraft();
    setTagDraft('');
    set('tags', tagsNow);
    onSubmit({ ...values, tags: tagsNow });
  };

  const onFormKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };

  const onTagKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === 'Enter' && !e.ctrlKey && !e.metaKey) || e.key === ',') {
      e.preventDefault();
      commitDraft();
    } else if (e.key === 'Backspace' && !tagDraft && values.tags.length) {
      set('tags', values.tags.slice(0, -1));
    }
  };

  return (
    <form className="doc-form" onSubmit={submit} onKeyDown={onFormKey}>
      <label>
        Category
        <input
          list={ids.cats}
          value={values.category}
          onChange={(e) => set('category', e.target.value)}
          autoFocus={autoFocus}
          required
        />
        <datalist id={ids.cats}>
          {categories.map((c) => (
            <option key={c.name} value={c.name} />
          ))}
        </datalist>
      </label>

      <label>
        Title
        <input
          list={ids.titles}
          value={values.title}
          onChange={(e) => set('title', e.target.value)}
          required
        />
        <datalist id={ids.titles}>
          {titles.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </label>

      <label>
        Date
        <input
          type="date"
          value={values.date}
          onChange={(e) => set('date', e.target.value)}
          required
        />
      </label>

      <label>
        Tags
        <div className="tag-input">
          {values.tags.map((t) => (
            <span key={t} className="chip">
              {t}
              <button
                type="button"
                aria-label={`Remove ${t}`}
                onClick={() =>
                  set(
                    'tags',
                    values.tags.filter((x) => x !== t),
                  )
                }
              >
                ×
              </button>
            </span>
          ))}
          <input
            list={ids.tags}
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onKeyDown={onTagKey}
            onBlur={commitDraft}
            aria-label="Add tag"
            placeholder={values.tags.length ? '' : 'Enter or comma to add'}
          />
          <datalist id={ids.tags}>
            {tags.map((t) => (
              <option key={t.name} value={t.name} />
            ))}
          </datalist>
        </div>
      </label>

      <label>
        Notes
        <textarea rows={4} value={values.notes} onChange={(e) => set('notes', e.target.value)} />
      </label>

      <div className="dest" title="Destination in the library (a suffix is added on collision)">
        → {previewRelPath(values.category, values.title, values.date, ext)}
      </div>

      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {submitLabel}
        </button>
        {actions}
      </div>
      <div className="hint">Ctrl+Enter to {submitLabel.toLowerCase()}</div>
    </form>
  );
}
