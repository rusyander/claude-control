import { createReadStream, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  APK_FILE,
  apkStatus,
  installApk,
  startApkBuild,
  type ApkPaths,
} from '../../domains/mobile-apk/mobile-apk.ts';
import { panelHomeDir } from '../../lib/brand.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

/**
 * Телефонное приложение из панели: собрать APK тем же сборщиком, что
 * `pnpm mobile:apk`, поставить его на телефон по `adb` или скачать файлом.
 */
export function registerMobileApkRoutes(app: FastifyInstance): void {
  const paths = (): ApkPaths => ({ repoRoot: REPO_ROOT, stateDir: panelHomeDir() });

  app.get('/api/mobile/apk', () => apkStatus(paths()));

  app.post('/api/mobile/apk/build', async (_req, reply) => {
    if (!startApkBuild(paths())) return reply.code(409).send({ error: 'busy' });
    return apkStatus(paths());
  });

  app.post<{ Body: { device?: unknown } }>('/api/mobile/apk/install', async (req, reply) => {
    const device = req.body?.device;
    if (typeof device !== 'string' || !device) return reply.code(400).send({ error: 'device' });
    const result = await installApk(paths(), device);
    // Файла нет или телефон отключился между опросом и нажатием.
    if (!result) return reply.code(409).send({ error: 'gone' });
    return result;
  });

  app.get('/api/mobile/apk/file', (_req, reply) => {
    const file = join(REPO_ROOT, APK_FILE);
    if (!existsSync(file)) return reply.code(404).send({ error: 'missing' });
    return reply
      .type('application/vnd.android.package-archive')
      .header('content-disposition', `attachment; filename="${APK_FILE}"`)
      .send(createReadStream(file));
  });
}
