import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../lib/app-store.ts';
import type { ServerContext } from '../context.ts';
import { registerGroupRoutes } from './group-routes.ts';

/**
 * Групповой тумблер и ОБЩИЕ файлы: правила лежат в одном `CLAUDE.md`, права — в
 * одном `settings.json`.
 *
 * Главное здесь — порядок разрешения идентификаторов. У правила нет своего ключа
 * на диске: id выводится из заголовка при каждом разборе, а порядок вывода —
 * сперва включённые, потом выключенные. Поэтому у двух правил с ОДИНАКОВЫМ
 * заголовком гашение первого меняет местами id обоих (`тест` ↔ `тест-2`).
 * Поштучный проход брал следующий id из списка, составленного ДО перезаписи, и
 * попадал уже в другое правило — второе одноимённое правило группа не гасила.
 *
 * Второй тест — про количество записей: резервная копия пишется на каждую
 * запись файла, поэтому их число прямо показывает, читался и переписывался ли
 * общий файл на каждого участника или один раз на всю группу.
 */
describe('групповой тумблер: одна запись на общий файл', () => {
  let root: string;
  let app: FastifyInstance;
  let store: AppStore;

  const settingsPath = (): string => join(root, 'settings.json');
  const claudeMdPath = (): string => join(root, 'CLAUDE.md');
  const backupDir = (): string => join(root, 'claude-control', 'backups');

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cc-group-batch-'));
    mkdirSync(join(root, 'claude-control'), { recursive: true });

    // Два правила с ОДИНАКОВЫМ заголовком: `obschee-pravilo` и `obschee-pravilo-2`.
    writeFileSync(
      claudeMdPath(),
      '# Правила\n\n' +
        '## ПРАВИЛО: Общее правило\n\nПервое тело.\n\n' +
        '## ПРАВИЛО: Общее правило\n\nВторое тело.\n',
      'utf8',
    );
    writeFileSync(
      settingsPath(),
      JSON.stringify({ permissions: { deny: ['Bash(rm:*)', 'Bash(sudo:*)'] } }, null, 2),
    );

    store = new AppStore(join(root, 'claude-control'));

    const ctx = {
      location: {
        paths: {
          root,
          settings: settingsPath(),
          settingsLocal: join(root, 'settings.local.json'),
          claudeMd: claudeMdPath(),
          skills: join(root, 'skills'),
          hooks: join(root, 'hooks'),
          mcpConfig: join(root, '.claude.json'),
          secretsEnv: join(root, '.mcp-secrets.env'),
        },
      },
      store,
      backupDir: backupDir(),
    } as unknown as ServerContext;

    app = Fastify();
    registerGroupRoutes(app, ctx);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  const createGroup = async (members: { kind: string; id: string }[]): Promise<string> => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      payload: { name: 'Набор', members },
    });
    return created.json<{ id: string }>().id;
  };

  const toggle = (id: string, isEnabled: boolean) =>
    app.inject({ method: 'POST', url: `/api/groups/${id}/enabled`, payload: { isEnabled } });

  it('гасит ОБА одноимённых правила, хотя гашение первого переименовывает второе', async () => {
    const groupId = await createGroup([
      { kind: 'rule', id: 'obschee-pravilo' },
      { kind: 'rule', id: 'obschee-pravilo-2' },
    ]);

    await toggle(groupId, false);

    const markdown = readFileSync(claudeMdPath(), 'utf8');
    const [, disabled = ''] = markdown.split(/^## .*Отключённые.*$/m);

    // Оба тела — в разделе отключённых, ни одно не осталось действующим.
    expect(disabled).toContain('Первое тело.');
    expect(disabled).toContain('Второе тело.');
    expect(markdown.split('Первое тело.')).toHaveLength(2);
  });

  it('включение возвращает оба правила', async () => {
    const groupId = await createGroup([
      { kind: 'rule', id: 'obschee-pravilo' },
      { kind: 'rule', id: 'obschee-pravilo-2' },
    ]);

    await toggle(groupId, false);
    await toggle(groupId, true);

    const markdown = readFileSync(claudeMdPath(), 'utf8');
    expect(markdown).not.toMatch(/Отключённые/);
    expect(markdown).toContain('Первое тело.');
    expect(markdown).toContain('Второе тело.');
  });

  it('снимает оба права группы одной записью settings.json', async () => {
    const groupId = await createGroup([
      { kind: 'permission', id: 'deny:Bash(rm:*)' },
      { kind: 'permission', id: 'deny:Bash(sudo:*)' },
    ]);

    await toggle(groupId, false);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      permissions?: { deny?: string[] };
    };
    expect(settings.permissions?.deny ?? []).toEqual([]);

    // Резервная копия одна на всю группу, а не по копии на участника.
    const backups = readdirSafe(backupDir()).filter((name) => name.startsWith('settings.json'));
    expect(backups).toHaveLength(1);
  });

  it('возвращает оба права на место при включении', async () => {
    const groupId = await createGroup([
      { kind: 'permission', id: 'deny:Bash(rm:*)' },
      { kind: 'permission', id: 'deny:Bash(sudo:*)' },
    ]);

    await toggle(groupId, false);
    await toggle(groupId, true);

    const settings = JSON.parse(readFileSync(settingsPath(), 'utf8')) as {
      permissions?: { deny?: string[] };
    };
    expect(settings.permissions?.deny ?? []).toEqual(['Bash(rm:*)', 'Bash(sudo:*)']);
  });

  it('правила группы переписывают CLAUDE.md один раз, а не по разу на участника', async () => {
    const groupId = await createGroup([
      { kind: 'rule', id: 'obschee-pravilo' },
      { kind: 'rule', id: 'obschee-pravilo-2' },
    ]);

    await toggle(groupId, false);

    const backups = readdirSafe(backupDir()).filter((name) => name.startsWith('CLAUDE.md'));
    expect(backups).toHaveLength(1);
  });
});

/** Каталог копий появляется только после первой записи — до неё его нет. */
function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
