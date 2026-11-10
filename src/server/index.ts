import { buildApp } from './app';
import { loadConfig } from './config';
import { openLibrary } from './context';

const config = loadConfig();
const { db, library } = openLibrary(config, {
  warn: (obj, msg) => app.log.warn(obj, msg),
});

const app = await buildApp({
  library,
  pullScript: config.pullScript,
  webDist: config.webDist,
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

app.log.info(
  { inbox: config.inboxDir, library: config.libraryDir, data: config.dataDir },
  'wcdocmanager paths',
);
await app.listen({ host: config.host, port: config.port });
