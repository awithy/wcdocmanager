import { createReadStream, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyServerOptions } from 'fastify';
import { z } from 'zod';
import type { FileInput, Settings, UpdateDocumentInput } from '../shared/types';
import { HttpError } from './errors';
import { runImport } from './importer';
import type { Library } from './library';

export interface AppDeps {
  library: Library;
  pullScript: string | null;
  webDist?: string;
  logger?: FastifyServerOptions['logger'];
}

const idParams = z.object({ id: z.coerce.number().int().positive() });
const nameParams = z.object({ name: z.string().min(1) });
const listQuery = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  tag: z.string().optional(),
});
const renameCategoryBody = z.object({ from: z.string(), to: z.string() });
const renameTitleBody = z.object({
  category: z.string(),
  from: z.string(),
  to: z.string(),
  toCategory: z.string().optional(),
});

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain; charset=utf-8',
};

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const hostnameOf = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

function sendFile(reply: FastifyReply, path: string) {
  const name = basename(path);
  return reply
    .type(MIME[extname(name).toLowerCase()] ?? 'application/octet-stream')
    .header('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`)
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(createReadStream(path));
}

export async function buildApp({ library, pullScript, webDist, logger = false }: AppDeps) {
  const app = Fastify({ logger });

  // No auth by design (single user, bound to 127.0.0.1). This blocks the two ways a web page in
  // the same browser could still reach the API: DNS rebinding (foreign Host) and cross-site
  // form POSTs (foreign Origin).
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (!LOCAL_HOSTS.has(hostnameOf(host))) {
      return reply.status(403).send({ error: 'Forbidden', message: 'Local access only' });
    }
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin) {
      let originHost = '';
      try {
        originHost = new URL(origin).host;
      } catch {
        // Treat as foreign.
      }
      if (originHost !== host) {
        return reply.status(403).send({ error: 'Forbidden', message: 'Cross-origin request' });
      }
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply
        .status(400)
        .send({ error: 'Bad Request', message: err.issues.map((i) => i.message).join('; ') });
    }
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.name, message: err.message });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply
        .status(statusCode)
        .send({ error: 'Bad Request', message: (err as Error).message });
    }
    reply.log.error(err);
    return reply
      .status(500)
      .send({ error: 'Internal Server Error', message: (err as Error).message });
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/settings', async (): Promise<Settings> => ({
    inboxDir: library.paths.inboxDir,
    libraryDir: library.paths.libraryDir,
    importEnabled: pullScript !== null,
  }));

  // ------------------------------------------------------------- inbox

  app.get('/api/inbox', async () => library.listInbox());

  app.get('/api/inbox/:name/content', async (req, reply) =>
    sendFile(reply, await library.inboxFile(nameParams.parse(req.params).name)),
  );

  app.post('/api/inbox/:name/file', async (req, reply) => {
    const doc = await library.fileItem(nameParams.parse(req.params).name, req.body as FileInput);
    return reply.status(201).send(doc);
  });

  app.post('/api/inbox/:name/discard', async (req, reply) => {
    await library.discardItem(nameParams.parse(req.params).name);
    return reply.status(204).send();
  });

  app.post('/api/import', async (_req, reply) => {
    if (!pullScript)
      return reply.status(404).send({ error: 'Not Found', message: 'Import disabled' });
    return runImport(pullScript);
  });

  // ------------------------------------------------------------- library

  app.get('/api/documents', async (req) => library.listDocuments(listQuery.parse(req.query)));

  app.get('/api/documents/:id', async (req) => library.getDocument(idParams.parse(req.params).id));

  app.get('/api/documents/:id/content', async (req, reply) =>
    sendFile(reply, await library.documentFile(idParams.parse(req.params).id)),
  );

  app.patch('/api/documents/:id', async (req) =>
    library.updateDocument(idParams.parse(req.params).id, req.body as UpdateDocumentInput),
  );

  app.get('/api/categories', async () => library.categories());
  app.get('/api/tags', async () => library.tags());

  app.post('/api/categories/rename', async (req) => {
    const { from, to } = renameCategoryBody.parse(req.body);
    return library.renameCategory(from, to);
  });

  app.post('/api/titles/rename', async (req) => {
    const { category, from, to, toCategory } = renameTitleBody.parse(req.body);
    return library.renameTitle(category, from, to, toCategory);
  });

  app.get('/api/check', async () => library.check());
  app.post('/api/reorganize', async () => library.reorganize());

  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
  }

  return app;
}
