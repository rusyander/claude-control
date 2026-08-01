import { describe, it, expect } from 'vitest';
import type { ClaudePaths } from '@claude-control/contracts';
import { createConfigWatcher, domainsForPath, type WatcherLike } from './config-watcher.ts';

/**
 * Наблюдатель за конфигами. Настоящий chokidar не поднимаем — подставляем
 * управляемый фейк и проверяем ровно ту регрессию, ради которой модуль
 * появился: тумблер «следить за изменениями» и каталог конфигурации раньше
 * замерзали на момент старта процесса.
 */

/** Фейковый наблюдатель: помнит пути, факт закрытия и умеет прислать событие. */
class FakeWatcher implements WatcherLike {
  closed = false;
  private handler?: (event: string, path: string) => void;
  readonly paths: string[];

  constructor(paths: string[]) {
    this.paths = paths;
  }

  on(_event: 'all', handler: (event: string, path: string) => void): unknown {
    this.handler = handler;
    return this;
  }

  close(): unknown {
    this.closed = true;
    return undefined;
  }

  emit(path: string): void {
    this.handler?.('change', path);
  }
}

const pathsIn = (root: string): ClaudePaths =>
  ({
    root,
    settings: `${root}/settings.json`,
    settingsLocal: `${root}/settings.local.json`,
    claudeMd: `${root}/CLAUDE.md`,
    secretsEnv: `${root}/.mcp-secrets.env`,
    skills: `${root}/skills`,
    mcpConfig: `${root}/.claude.json`,
    appData: `${root}/claude-control`,
  }) as unknown as ClaudePaths;

/** Дождаться конца окна склейки: рассылка отложена таймером, а не мгновенна. */
const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 1200));

function harness(initial: { enabled: boolean; root: string }) {
  const state = { ...initial };
  const created: FakeWatcher[] = [];
  const broadcasts: { domains: string[]; path: string }[] = [];

  const watcher = createConfigWatcher({
    read: () => ({ enabled: state.enabled, paths: pathsIn(state.root) }),
    broadcast: (domains, path) => broadcasts.push({ domains, path }),
    createWatcher: (paths) => {
      const fake = new FakeWatcher(paths);
      created.push(fake);
      return fake;
    },
  });

  return { state, created, broadcasts, watcher };
}

describe('createConfigWatcher', () => {
  it('выключенный тумблер не поднимает наблюдателя', () => {
    const { created, watcher } = harness({ enabled: false, root: '/cfg-a' });
    watcher.sync();
    expect(created.length).toBe(0);
    expect(watcher.watched()).toEqual([]);
  });

  // Регрессия: выключение тумблера раньше не действовало до перезапуска —
  // наблюдатель продолжал слать события и дёргать интерфейс.
  it('выключение тумблера гасит уже идущего наблюдателя', () => {
    const { state, created, watcher } = harness({ enabled: true, root: '/cfg-a' });
    watcher.sync();
    expect(created.length).toBe(1);

    state.enabled = false;
    watcher.sync();
    expect(created[0]!.closed).toBe(true);
    expect(watcher.watched()).toEqual([]);
  });

  // Регрессия: включение тумблера после старта с выключенным не делало ничего.
  it('включение тумблера поднимает наблюдателя без перезапуска процесса', () => {
    const { state, created, watcher } = harness({ enabled: false, root: '/cfg-a' });
    watcher.sync();
    expect(created.length).toBe(0);

    state.enabled = true;
    watcher.sync();
    expect(created.length).toBe(1);
    expect(created[0]!.paths).toContain('/cfg-a/CLAUDE.md');
  });

  // Регрессия: после смены каталога конфигурации следили за ЧУЖИМИ файлами.
  it('смена каталога пересоздаёт наблюдателя на новых путях', () => {
    const { state, created, watcher } = harness({ enabled: true, root: '/cfg-a' });
    watcher.sync();

    state.root = '/cfg-b';
    watcher.sync();

    expect(created.length).toBe(2);
    expect(created[0]!.closed).toBe(true);
    expect(created[1]!.paths).toContain('/cfg-b/CLAUDE.md');
    expect(watcher.watched().every((path) => path.startsWith('/cfg-b'))).toBe(true);
  });

  it('повторный sync без изменений наблюдателя не пересоздаёт', () => {
    const { created, watcher } = harness({ enabled: true, root: '/cfg-a' });
    watcher.sync();
    watcher.sync();
    watcher.sync();
    expect(created.length).toBe(1);
    expect(created[0]!.closed).toBe(false);
  });

  it('событие наблюдателя уходит подписчикам с разделами по пути', async () => {
    const { created, broadcasts, watcher } = harness({ enabled: true, root: '/cfg-a' });
    watcher.sync();
    created[0]!.emit('/cfg-a/skills/my-skill/SKILL.md');

    // Рассылка идёт через окно склейки — до его конца подписчики молчат.
    expect(broadcasts).toEqual([]);
    await settle();
    expect(broadcasts).toEqual([{ domains: ['skills'], path: '/cfg-a/skills/my-skill/SKILL.md' }]);
  });

  it('поток правок транскрипта склеивается в одну рассылку', async () => {
    // Транскрипт идущего разговора дописывается непрерывно: без склейки панель
    // перечитывала бы ленту на каждую дописанную строку.
    const { created, broadcasts, watcher } = harness({ enabled: true, root: '/cfg-a' });
    watcher.sync();
    created[0]!.emit('/cfg-a/projects/proj/s1.jsonl');
    created[0]!.emit('/cfg-a/projects/proj/s1.jsonl');
    created[0]!.emit('/cfg-a/projects/proj/s1.jsonl');
    await settle();

    expect(broadcasts).toEqual([{ domains: ['chats'], path: '/cfg-a/projects/proj/s1.jsonl' }]);
  });

  it('разные разделы за одно окно уходят вместе, не теряясь', async () => {
    const { created, broadcasts, watcher } = harness({ enabled: true, root: '/cfg-a' });
    watcher.sync();
    created[0]!.emit('/cfg-a/projects/proj/s1.jsonl');
    created[0]!.emit('/cfg-a/skills/my-skill/SKILL.md');
    await settle();

    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]!.domains.sort()).toEqual(['chats', 'skills']);
  });
});

describe('domainsForPath', () => {
  const paths = pathsIn('/cfg-a');

  it('настройки обновляют хуки, права и переменные', () => {
    expect(domainsForPath(paths, paths.settings)).toEqual(['hooks', 'permissions', 'env']);
    expect(domainsForPath(paths, paths.settingsLocal)).toEqual(['hooks', 'permissions', 'env']);
  });

  it('прочее — общая сводка', () => {
    expect(domainsForPath(paths, '/cfg-a/что-то.json')).toEqual(['overview']);
  });
});
