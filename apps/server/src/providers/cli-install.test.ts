import { describe, expect, it } from 'vitest';
import { compareCliVersions, readCliInfo, updateCli, type CliExec } from './cli-install.ts';

/**
 * Какой CLI панель запускает (живой прогон 25.09.2026): первой в PATH стояла
 * копия 2.1.278 в каталоге nvm, рядом — 2.1.282, и панель молча работала
 * старой. Подменён только запуск процессов — граница с ОС; разбор вывода
 * `where`/`which` и `--version`, выбор запускаемой и новейшей копии — настоящие.
 */

const OLD = 'C:/nvm4w/nodejs/claude.cmd';
const NEW = 'C:/Users/me/AppData/Roaming/npm/claude.cmd';
const NATIVE = 'C:/Users/me/.local/bin/claude.exe';

function machine(
  onPath: Record<string, string[]>,
  versions: Record<string, string>,
): { exec: CliExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: CliExec = (file, args) => {
    calls.push([file, ...args]);
    if (file === 'where' || file === 'which') {
      const name = args.at(-1) ?? '';
      const found = onPath[name] ?? [];
      return { status: found.length ? 0 : 1, stdout: found.join('\r\n') };
    }
    if (args[0] === '--version') {
      const version = versions[file];
      return version
        ? { status: 0, stdout: `${version} (Claude Code)\n` }
        : { status: 1, stdout: '' };
    }
    if (args[0] === 'update') return { status: 0, stdout: 'Successfully updated' };
    return { status: 1, stdout: '' };
  };
  return { exec, calls };
}

describe('readCliInfo', () => {
  it('запускается первая копия имени запуска; новее рядом — названа', () => {
    const { exec } = machine(
      { 'claude.cmd': [OLD, NEW], claude: [OLD, NEW, NATIVE] },
      { [OLD]: '2.1.278', [NEW]: '2.1.282', [NATIVE]: '2.1.280' },
    );

    const info = readCliInfo('claude.cmd', ['claude.cmd', 'claude'], { exec });

    expect(info).toMatchObject({ command: 'claude.cmd', path: OLD, version: '2.1.278' });
    expect(info.installs.map((install) => install.path)).toEqual([OLD, NEW, NATIVE]);
    expect(info.newer).toEqual({ path: NEW, version: '2.1.282' });
  });

  it('запускается новейшая — «есть новее» нет', () => {
    const { exec } = machine({ 'claude.cmd': [NEW, OLD] }, { [OLD]: '2.1.278', [NEW]: '2.1.282' });

    const info = readCliInfo('claude.cmd', ['claude.cmd'], { exec });

    expect(info.path).toBe(NEW);
    expect(info.newer).toBeUndefined();
  });

  it('CLI нет в PATH — ни пути, ни версии, копий ноль', () => {
    const { exec } = machine({}, {});

    expect(readCliInfo('claude.cmd', ['claude.cmd', 'claude'], { exec })).toEqual({
      command: 'claude.cmd',
      installs: [],
    });
  });

  it('копия, не ответившая на --version, без версии и новее не считается', () => {
    const { exec } = machine({ 'claude.cmd': [OLD, NEW] }, { [OLD]: '2.1.278' });

    const info = readCliInfo('claude.cmd', ['claude.cmd'], { exec });

    expect(info.installs).toEqual([{ path: OLD, version: '2.1.278' }, { path: NEW }]);
    expect(info.newer).toBeUndefined();
  });
});

// Живой стенд 25.09: `where claude` отдавал и sh-обёртки npm без расширения.
it.runIf(process.platform === 'win32')('sh-обёртка без расширения — не копия CLI', () => {
  const { exec } = machine(
    { 'claude.cmd': [OLD], claude: ['C:/nvm4w/nodejs/claude', OLD] },
    { [OLD]: '2.1.282' },
  );

  const info = readCliInfo('claude.cmd', ['claude.cmd', 'claude'], { exec });

  expect(info.installs).toEqual([{ path: OLD, version: '2.1.282' }]);
});

describe('compareCliVersions', () => {
  it('сравнивает по числам, а не строкам', () => {
    expect(compareCliVersions('2.1.280', '2.1.278')).toBeGreaterThan(0);
    expect(compareCliVersions('2.1.9', '2.1.10')).toBeLessThan(0);
    expect(compareCliVersions('2.1.10', '2.1.10')).toBe(0);
    expect(compareCliVersions(undefined, '0.0.1')).toBeLessThan(0);
  });
});

describe('updateCli', () => {
  it('обновляет именно запускаемую копию', () => {
    const { exec, calls } = machine({}, {});

    expect(updateCli(OLD, { exec })).toEqual({ ok: true, output: 'Successfully updated' });
    expect(calls).toEqual([[OLD, 'update']]);
  });
});
