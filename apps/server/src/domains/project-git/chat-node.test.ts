import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { chatNodeDirs, resetChatNodeCache, withChatNode, type ChatNodeDeps } from './chat-node.ts';

/**
 * Node проекта в PATH чата: живое ревью 18.10.2026 искало путь к Node 22 трижды,
 * потому что чат шёл на PATH по умолчанию (24). Подмена — только когда проект
 * просит другую версию и она стоит на машине; свой CLI в её каталоге её отменяет.
 */

const NODE22 = join('C:', 'nvm', 'v22.23.2');

function project(nvmrc?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chat-node-'));
  if (nvmrc) writeFileSync(join(dir, '.nvmrc'), `${nvmrc}\n`);
  return dir;
}

function deps(over: Partial<ChatNodeDeps> = {}): ChatNodeDeps & { calls: number } {
  const state = { calls: 0, clock: 0 };
  return {
    defaultNode: () => {
      state.calls += 1;
      return 'v24.13.0';
    },
    installed: () => [
      { version: [22, 23, 2], text: '22.23.2', dir: NODE22, manager: 'nvm-windows' },
      {
        version: [24, 13, 0],
        text: '24.13.0',
        dir: join('C:', 'nvm', 'v24.13.0'),
        manager: 'nvm-windows',
      },
    ],
    exists: () => false,
    now: () => state.clock,
    get calls() {
      return state.calls;
    },
    ...over,
  };
}

const ENV = { PATH: '/usr/bin' };

describe('chat-node: Node проекта первым в PATH чата', () => {
  beforeEach(() => resetChatNodeCache());

  it('проект просит 22, по умолчанию 24, 22 установлен — его каталог первым в PATH', () => {
    const env = withChatNode(project('22'), ENV, 'claude', deps());
    expect(env.PATH?.startsWith(NODE22)).toBe(true);
    expect(env.PATH?.endsWith('/usr/bin')).toBe(true);
  });

  it('без требования версии и при подходящей версии PATH не меняется', () => {
    expect(withChatNode(project(), ENV, 'claude', deps())).toBe(ENV);
    expect(withChatNode(project('24'), ENV, 'claude', deps())).toBe(ENV);
  });

  it('нужной версии на машине нет — PATH не меняется', () => {
    expect(chatNodeDirs(project('20'), ENV, 'claude', deps())).toBeUndefined();
  });

  it('свой claude в каталоге Node (nvm-windows) — впереди встаёт каталог прежнего CLI', () => {
    const npm = join('C:', 'npm');
    const env = { PATH: [join('C:', 'empty'), npm, '/usr/bin'].join(delimiter) };
    const files = new Set([join(NODE22, 'claude.cmd'), join(npm, 'claude.cmd')]);
    const own = deps({ exists: (p) => files.has(p) });
    expect(chatNodeDirs(project('22'), env, 'claude', own)).toEqual([npm, NODE22]);
    const wired = withChatNode(project('22'), env, 'claude', own).PATH?.split(delimiter);
    expect(wired?.slice(0, 3)).toEqual([npm, NODE22, join('C:', 'empty')]);
    resetChatNodeCache();
    // Рядом с прежним CLI свой Node — впереди он снова дал бы не ту версию.
    files.add(join(npm, 'node.exe'));
    expect(chatNodeDirs(project('22'), env, 'claude', own)).toBeUndefined();
    resetChatNodeCache();
    // CLI по PATH не найден — подмены нет.
    expect(chatNodeDirs(project('22'), ENV, 'claude', own)).toBeUndefined();
    resetChatNodeCache();
    // Абсолютный путь CLI по PATH не ищется — подмена безопасна.
    expect(chatNodeDirs(project('22'), ENV, join('C:', 'bin', 'claude.exe'), own)).toEqual([
      NODE22,
    ]);
  });

  it('версия по умолчанию спрашивается раз на PATH, совпадение по каталогу живёт минуту', () => {
    let clock = 0;
    const d = deps({ now: () => clock });
    const dir = project('22');
    chatNodeDirs(dir, ENV, 'claude', d);
    chatNodeDirs(dir, ENV, 'claude', d);
    chatNodeDirs(project('22'), ENV, 'claude', d);
    expect(d.calls).toBe(1);
    let scans = 0;
    const counted = deps({ now: () => clock, installed: () => (scans++, []) });
    clock = 61_000;
    expect(chatNodeDirs(dir, ENV, 'claude', counted)).toBeUndefined();
    expect(scans).toBe(1);
  });
});
