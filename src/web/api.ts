import type {
  CategorySummary,
  CheckReport,
  DocumentRecord,
  FileInput,
  ImportResult,
  InboxItem,
  MoveReport,
  Settings,
  TagSummary,
  UpdateDocumentInput,
} from '../shared/types';

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  settings: () => request<Settings>('GET', '/api/settings'),
  inbox: () => request<InboxItem[]>('GET', '/api/inbox'),
  inboxContentUrl: (name: string) => `/api/inbox/${enc(name)}/content`,
  fileItem: (name: string, input: FileInput) =>
    request<DocumentRecord>('POST', `/api/inbox/${enc(name)}/file`, input),
  discard: (name: string) => request<void>('POST', `/api/inbox/${enc(name)}/discard`),
  import: () => request<ImportResult>('POST', '/api/import'),

  documents: (query: { q?: string; category?: string; tag?: string }) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
    return request<DocumentRecord[]>('GET', `/api/documents?${params}`);
  },
  document: (id: number) => request<DocumentRecord>('GET', `/api/documents/${id}`),
  documentContentUrl: (id: number, version: string) =>
    `/api/documents/${id}/content?v=${enc(version)}`,
  updateDocument: (id: number, input: UpdateDocumentInput) =>
    request<DocumentRecord>('PATCH', `/api/documents/${id}`, input),

  categories: () => request<CategorySummary[]>('GET', '/api/categories'),
  tags: () => request<TagSummary[]>('GET', '/api/tags'),
  renameCategory: (from: string, to: string) =>
    request<MoveReport>('POST', '/api/categories/rename', { from, to }),
  renameTitle: (category: string, from: string, to: string, toCategory?: string) =>
    request<MoveReport>('POST', '/api/titles/rename', { category, from, to, toCategory }),
  check: () => request<CheckReport>('GET', '/api/check'),
  reorganize: () => request<MoveReport>('POST', '/api/reorganize'),
};
