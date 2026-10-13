import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetChangelogMemo } from '../../domains/changelog/changelog.ts';
import { registerChangelogRoutes } from './changelog-routes.ts';

/**
 * Маршруты ленты поверх настоящего Fastify и настоящих файлов: подставлен только
 * корень репозитория (временный каталог без `.git`). Главный вопрос — снимки:
 * что отдаётся и что НЕ отдаётся (выход за каталог, SVG, чужой регистр, каталог).
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

let root: string;
let app: FastifyInstance;

beforeEach(async () => {
  resetChangelogMemo();
  root = mkdtempSync(join(tmpdir(), 'cc-changelog-routes-'));
  mkdirSync(join(root, 'changelog', 'entries'), { recursive: true });
  mkdirSync(join(root, 'changelog', 'assets', '2026-10-12-x'), { recursive: true });
  writeFileSync(
    join(root, 'changelog', 'entries', '2026-10-12-x.json'),
    JSON.stringify({
      title: { ru: 'Описание' },
      items: [{ kind: 'fixed', text: { ru: 'пункт' }, images: ['shot.png'] }],
    }),
  );
  writeFileSync(join(root, 'changelog', 'assets', '2026-10-12-x', 'shot.png'), PNG);
  writeFileSync(
    join(root, 'changelog', 'assets', '2026-10-12-x', 'vector.svg'),
    '<svg onload="x()"/>',
  );
  writeFileSync(join(root, 'changelog', 'secret.png'), PNG);
  writeFileSync(join(root, 'secret.png'), PNG);
  mkdirSync(join(root, 'changelog', 'assets', '2026-10-12-x', 'dir.png'));
  app = Fastify();
  registerChangelogRoutes(app, root);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/changelog', () => {
  it('отдаёт ленту: описание, адрес снимка и признак «git недоступен»', async () => {
    const res = await app.inject('/api/changelog');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.gitAvailable).toBe(false);
    expect(body.invalid).toEqual([]);
    expect(body.entries[0].items[0].images).toEqual([
      '/api/changelog/assets/2026-10-12-x/shot.png',
    ]);
  });
});

describe('GET /api/changelog/assets/:id/:file', () => {
  it('настоящий снимок — 200, свой тип, те же байты', async () => {
    const res = await app.inject('/api/changelog/assets/2026-10-12-x/shot.png');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.rawPayload.equals(PNG)).toBe(true);
  });

  it.each([
    ['выход из каталога через имя', '/api/changelog/assets/2026-10-12-x/..%2f..%2fsecret.png'],
    ['выход из каталога через id', '/api/changelog/assets/..%2f../secret.png'],
    ['выход через id с точками', '/api/changelog/assets/../shot.png'],
    ['SVG не отдаётся', '/api/changelog/assets/2026-10-12-x/vector.svg'],
    ['чужой регистр', '/api/changelog/assets/2026-10-12-x/SHOT.PNG'],
    ['нет такого файла', '/api/changelog/assets/2026-10-12-x/none.png'],
    ['нет такого id', '/api/changelog/assets/2026-01-01-none/shot.png'],
    ['каталог под именем снимка', '/api/changelog/assets/2026-10-12-x/dir.png'],
  ])('%s — 404', async (_name, url) => {
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
  });
});

// Перемотку настоящим git проверяет panel-update.git.test.ts; здесь — что маршрут
// доходит до домена с каталогом панели и не обновляет то, что не клон.
describe('/api/panel-update', () => {
  it('GET вне клона git — состояние not-git', async () => {
    const res = await app.inject('/api/panel-update?refresh=1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ state: 'not-git', behind: 0, dirty: [] });
  });

  it('POST вне клона git — отказ с причиной, без обновления', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/panel-update' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, error: 'not-git' });
  });
});
