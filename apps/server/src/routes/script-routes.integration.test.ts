import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerScriptRoutes } from './script-routes.ts';
import { getProvider } from '../providers/registry.ts';

/**
 * COMMON-1: «Скрипты» — раздел САМОЙ панели (файлы пользователя в её каталоге
 * hooks/), а не адаптер к конфигу CLI. Значит он обязан работать при любом
 * активном провайдере — и работать одинаково: создать, прочитать, изменить,
 * удалить. Ничего провайдер-специфичного маршруты не читают и не пишут.
 *
 * Всё во временном каталоге — настоящий ~/.claude не затрагивается.
 */
function makeCtx(root: string, provider: string): ServerContext {
  mkdirSync(join(root, 'claude-control'), { recursive: true });
  mkdirSync(join(root, 'hooks'), { recursive: true });
  const store = new AppStore(join(root, 'claude-control'));
  if (provider !== 'claude') store.updateSettings({ provider });

  return {
    location: {
      paths: {
        root,
        settings: join(root, 'settings.json'),
        hooks: join(root, 'hooks'),
        appData: join(root, 'claude-control'),
      },
    },
    store,
    backupDir: join(root, 'claude-control', 'backups'),
  } as unknown as ServerContext;
}

interface ScriptRow {
  id: string;
  name: string;
  isUsed: boolean;
}

describe('роуты скриптов: работают при любом активном провайдере', () => {
  let root: string;
  let app: FastifyInstance;

  const bootWith = async (provider: string): Promise<void> => {
    app = Fastify();
    registerScriptRoutes(app, makeCtx(root, provider));
    await app.ready();
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-script-route-'));
  });
  afterEach(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  // Каталог заявленных возможностей: заглушки «в разработке» у скриптов больше
  // нет ни у кого — иначе рабочие маршруты ниже были бы недостижимы из панели.
  it('scripts объявлен ready у всех провайдеров (заглушки больше нет)', () => {
    for (const id of ['claude', 'codex', 'gemini', 'cursor', 'opencode', 'aider']) {
      expect(getProvider(id).capabilities.scripts, id).toBe('ready');
    }
  });

  for (const provider of ['claude', 'codex', 'aider']) {
    it(`${provider}: полный цикл создать → прочитать → изменить → удалить`, async () => {
      await bootWith(provider);

      const created = await app.inject({
        method: 'POST',
        url: '/api/scripts',
        payload: { name: 'notify.mjs', content: '// первый\n' },
      });
      expect(created.statusCode).toBe(200);
      expect(readFileSync(join(root, 'hooks', 'notify.mjs'), 'utf8')).toBe('// первый\n');

      const list = await app.inject({ method: 'GET', url: '/api/scripts' });
      expect(list.json<ScriptRow[]>().map((item) => item.id)).toEqual(['notify.mjs']);

      const one = await app.inject({ method: 'GET', url: '/api/scripts/notify.mjs' });
      expect(one.json<{ content: string }>().content).toBe('// первый\n');

      const saved = await app.inject({
        method: 'PUT',
        url: '/api/scripts/notify.mjs',
        payload: { content: '// второй\n' },
      });
      expect(saved.statusCode).toBe(200);
      expect(readFileSync(join(root, 'hooks', 'notify.mjs'), 'utf8')).toBe('// второй\n');

      const removed = await app.inject({ method: 'DELETE', url: '/api/scripts/notify.mjs' });
      expect(removed.statusCode).toBe(200);
      expect(existsSync(join(root, 'hooks', 'notify.mjs'))).toBe(false);
      // Копия снимается до стирания — удаление отменяемо у любого провайдера.
      expect(removed.json<{ backupPath?: string }>().backupPath).toBeTruthy();
    });
  }

  it('отметка «вызывается хуком» считается как раньше — по хукам settings.json', async () => {
    writeFileSync(
      join(root, 'settings.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [{ hooks: [{ type: 'command', command: 'node hooks/used.mjs' }] }],
        },
      }),
      'utf8',
    );
    await bootWith('codex');
    writeFileSync(join(root, 'hooks', 'used.mjs'), '// used\n', 'utf8');
    writeFileSync(join(root, 'hooks', 'lonely.mjs'), '// lonely\n', 'utf8');

    const rows = await app.inject({ method: 'GET', url: '/api/scripts' });
    const byId = new Map(rows.json<ScriptRow[]>().map((item) => [item.id, item.isUsed]));
    expect(byId.get('used.mjs')).toBe(true);
    expect(byId.get('lonely.mjs')).toBe(false);
  });
});
