import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyReply } from 'fastify';
import { requireRoot } from './shared.ts';

/**
 * Путь проекта приводится к написанию на диске (регистр, слэши, 8.3), но ссылку
 * по дороге НЕ раскрывает: ревью 26.09 — проект за junction или на `subst`-диске
 * получал ключ по чужому пути, и реестры, открытые по пути из реестра проектов,
 * расходились с тем, что писали прогоны.
 */
const reply = {
  code: () => ({ send: () => undefined }),
} as unknown as FastifyReply;

describe('requireRoot', () => {
  let base = '';
  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-root-')));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('проект за ссылкой (junction) остаётся по своему пути, а не по цели', () => {
    const target = join(base, 'real');
    mkdirSync(target);
    const link = join(base, 'linked');
    symlinkSync(target, link, 'junction');
    expect(requireRoot(link, reply)).toBe(link);
    expect(requireRoot(join(link), reply)).not.toBe(target);
  });

  it.runIf(process.platform === 'win32')(
    'другое написание того же каталога — одно написание',
    () => {
      const dir = join(base, 'Proj');
      mkdirSync(dir);
      const other = dir.replace(/\\/g, '/').replace(/Proj$/, 'proj');
      expect(requireRoot(other, reply)).toBe(dir);
    },
  );
});
