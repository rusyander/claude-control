import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installTurnHooks,
  readTurnHooks,
  reconcileTurnHooks,
  removeTurnHooks,
} from './turn-hooks.ts';

/**
 * Хуки блока «Тесты» в `.claude/settings.local.json` проекта: ставятся сами,
 * чужое не трогают, выключение возвращает файл байт в байт, файл спрятан от git.
 * Настоящая файловая система и настоящий git во временном каталоге.
 */

const SCRIPT = 'C:/panel/tools/tests-hook.mjs';

describe('хуки блока «Тесты» в проекте', () => {
  let base = '';
  let appData = '';
  let root = '';
  let saved: { global?: string; xdg?: string } = {};
  const settingsFile = () => join(root, '.claude', 'settings.local.json');
  const settings = () =>
    JSON.parse(readFileSync(settingsFile(), 'utf8')) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
      permissions?: unknown;
    };
  const exclude = () => readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-turn-hooks-')));
    appData = join(base, 'app');
    root = join(base, 'proj');
    mkdirSync(appData);
    mkdirSync(root);
    // Глобальный игнор машины (Claude Code сам пишет туда settings.local.json) спрятал бы
    // ветку записи в исключения: гит теста видит только свой репозиторий.
    saved = { global: process.env.GIT_CONFIG_GLOBAL, xdg: process.env.XDG_CONFIG_HOME };
    writeFileSync(join(base, 'gitconfig'), '');
    process.env.GIT_CONFIG_GLOBAL = join(base, 'gitconfig');
    process.env.XDG_CONFIG_HOME = join(base, 'xdg');
    execFileSync('git', ['init', '-q'], { cwd: root });
  });
  afterEach(() => {
    for (const [name, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['XDG_CONFIG_HOME', saved.xdg],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('файл уже игнорируется гитом — в исключения ничего не дописывается', () => {
    mkdirSync(join(base, 'xdg', 'git'), { recursive: true });
    writeFileSync(join(base, 'xdg', 'git', 'ignore'), '**/.claude/settings.local.json\n');
    const before = existsSync(join(root, '.git', 'info', 'exclude')) ? exclude() : '';
    installTurnHooks(appData, root, SCRIPT);
    expect(existsSync(join(root, '.git', 'info', 'exclude')) ? exclude() : '').toBe(before);
  });

  it('ставит строку начала и проверку конца хода, прячет файл от git, повтор ничего не меняет', () => {
    expect(installTurnHooks(appData, root, SCRIPT)).toBe('on');
    const hooks = settings().hooks;
    expect(hooks.SessionStart?.[0]?.hooks[0]?.command).toBe(`node "${SCRIPT}" session`);
    expect(hooks.Stop?.[0]?.hooks[0]?.command).toBe(`node "${SCRIPT}" stop`);
    expect(exclude()).toContain('/.claude/settings.local.json');
    expect(
      execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' }),
    ).toBe('');
    const bytes = readFileSync(settingsFile(), 'utf8');
    installTurnHooks(appData, root, SCRIPT);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(bytes);
    expect(readTurnHooks(appData, root)).toBe('on');
  });

  it('чужие хуки и настройки остаются; новый путь панели заменяет свою запись, а не копит', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(
      settingsFile(),
      JSON.stringify({
        permissions: { allow: ['Bash(ls)'] },
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] },
      }),
    );
    installTurnHooks(appData, root, SCRIPT);
    installTurnHooks(appData, root, 'D:/moved/tools/tests-hook.mjs');
    const value = settings();
    expect(value.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(value.hooks.Stop?.map((entry) => entry.hooks[0]?.command)).toEqual([
      'echo mine',
      'node "D:/moved/tools/tests-hook.mjs" stop',
    ]);
  });

  it('выключение возвращает проект байт в байт и держится при старте панели; включение человеком — снова', () => {
    const excludeBefore = existsSync(join(root, '.git', 'info', 'exclude')) ? exclude() : '';
    installTurnHooks(appData, root, SCRIPT);
    expect(removeTurnHooks(appData, root)).toBe('off');
    expect(existsSync(settingsFile())).toBe(false);
    expect(exclude()).toBe(excludeBefore);
    reconcileTurnHooks(appData, [root], SCRIPT);
    expect(existsSync(settingsFile())).toBe(false);
    expect(readTurnHooks(appData, root)).toBe('off');
    expect(installTurnHooks(appData, root, SCRIPT, true)).toBe('on');
    expect(existsSync(settingsFile())).toBe(true);
  });

  it('файл правили после панели — выключение снимает только своё', () => {
    installTurnHooks(appData, root, SCRIPT);
    const edited = settings() as unknown as Record<string, unknown>;
    edited.model = 'opus';
    writeFileSync(settingsFile(), JSON.stringify(edited));
    removeTurnHooks(appData, root);
    expect(JSON.parse(readFileSync(settingsFile(), 'utf8'))).toEqual({ model: 'opus' });
  });

  it('битый личный файл не переписывается', () => {
    mkdirSync(join(root, '.claude'));
    writeFileSync(settingsFile(), '{ broken');
    expect(installTurnHooks(appData, root, SCRIPT)).toBe('broken');
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ broken');
  });
});
