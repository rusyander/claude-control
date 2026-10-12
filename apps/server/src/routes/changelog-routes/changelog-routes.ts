import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { getChangelog } from '../../domains/changelog/changelog.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Лента «Что нового» и снимки к описаниям. Снимки отдаются только растровые и
 * только из `changelog/assets`: имя проверяется по шаблону, а итоговый путь —
 * на выход за каталог (SVG не отдаётся совсем: в нём может быть сценарий).
 */
export function registerChangelogRoutes(app: FastifyInstance, repoRoot: string = REPO_ROOT): void {
  app.get('/api/changelog', () => getChangelog(repoRoot));

  app.get<{ Params: { id: string; file: string } }>(
    '/api/changelog/assets/:id/:file',
    async (req, reply) => {
      const { id, file } = req.params;
      const mime = MIME[file.split('.').pop()?.toLowerCase() ?? ''];
      if (!SAFE_NAME.test(id) || !SAFE_NAME.test(file) || !mime) {
        return reply.code(404).send({ error: 'missing' });
      }
      const root = resolve(repoRoot, 'changelog', 'assets');
      const path = resolve(join(root, id, file));
      if (!path.startsWith(root + sep)) return reply.code(404).send({ error: 'missing' });
      const info = await stat(path).catch(() => undefined);
      if (!info?.isFile()) return reply.code(404).send({ error: 'missing' });
      return reply
        .type(mime)
        .header('cache-control', 'no-cache')
        .header('content-length', info.size)
        .send(createReadStream(path));
    },
  );
}
