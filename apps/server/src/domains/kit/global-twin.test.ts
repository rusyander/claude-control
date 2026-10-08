import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeEntry } from '../../lib/safe-io/safe-io.ts';
import {
  exportToGlobal,
  globalItems,
  importFromGlobal,
  sameText,
  twinMain,
  twinRoot,
  type TwinDirs,
} from './global-twin.ts';

/**
 * Набор ↔ глобальный слой: всё на временных каталогах — настоящий `~/.claude`
 * тест не видит. Проверяется то, что увидит человек: какие файлы где легли,
 * что ушло в резервную копию и в архив.
 */

let root: string;
let dirs: TwinDirs;
let backupDir: string;
let archiveDir: string;

function put(base: string, rel: string, text: string): void {
  const path = join(base, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kit-twin-'));
  dirs = {
    builtinDir: join(root, 'builtin'),
    mineDir: join(root, 'mine'),
    globalDir: join(root, 'global'),
  };
  backupDir = join(root, 'backups');
  archiveDir = join(root, 'archive');
});

afterEach(() => removeEntry(root));

describe('пути элемента', () => {
  it('навык — папкой, команда и субагент — файлом', () => {
    expect(twinRoot('skill', 'a')).toBe('skills/a');
    expect(twinMain('skill', 'a')).toBe('skills/a/SKILL.md');
    expect(twinRoot('command', 'b')).toBe('commands/b.md');
    expect(twinRoot('agent', 'c')).toBe('agents/c.md');
  });
});

describe('sameText', () => {
  it('концы строк и хвостовые пробелы не различают тексты', () => {
    expect(sameText('a  \r\nb\n', 'a\nb')).toBe(true);
  });
  it('другое слово — другой текст', () => {
    expect(sameText('a\nb', 'a\nc')).toBe(false);
  });
});

describe('globalItems', () => {
  it('навыки с SKILL.md, команды и субагенты верхнего уровня, с описанием', () => {
    put(dirs.globalDir, 'skills/s1/SKILL.md', '---\nname: s1\ndescription: Skill one\n---\n');
    put(dirs.globalDir, 'skills/broken/notes.md', 'no main file');
    put(dirs.globalDir, 'commands/c1.md', '# c1\nDoes c1');
    put(dirs.globalDir, 'commands/nested/x.md', 'nested');
    put(dirs.globalDir, 'agents/a1.md', '---\nname: a1\ndescription: Agent one\n---\n');
    expect(
      globalItems(dirs.globalDir).map(({ kind, name, description }) => [kind, name, description]),
    ).toEqual([
      ['agent', 'a1', 'Agent one'],
      ['command', 'c1', 'Does c1'],
      ['skill', 's1', 'Skill one'],
    ]);
  });
  it('нет глобального слоя — пустой список, не ошибка', () => {
    expect(globalItems(join(root, 'absent'))).toEqual([]);
  });
});

describe('exportToGlobal', () => {
  it('навык ложится папкой: встроенные файлы, поверх — «моё»; прежняя версия — в копию', () => {
    put(dirs.builtinDir, 'skills/s/SKILL.md', 'builtin main');
    put(dirs.builtinDir, 'skills/s/references/r.md', 'builtin ref');
    put(dirs.mineDir, 'skills/s/SKILL.md', 'mine main');
    put(dirs.globalDir, 'skills/s/SKILL.md', 'old global');
    put(dirs.globalDir, 'skills/s/stale.md', 'stale');

    const backup = exportToGlobal(dirs, backupDir, 'skill', 's');

    expect(read(dirs.globalDir, 'skills/s/SKILL.md')).toBe('mine main');
    expect(read(dirs.globalDir, 'skills/s/references/r.md')).toBe('builtin ref');
    // Замена целиком: старый файл, которого нет в наборе, не остаётся третьей версией.
    expect(existsSync(join(dirs.globalDir, 'skills/s/stale.md'))).toBe(false);
    expect(backup).toBeDefined();
    expect(read(backup!, 'SKILL.md')).toBe('old global');
    expect(read(backup!, 'stale.md')).toBe('stale');
  });

  it('команды в глобальном не было — копии нет, файл появляется', () => {
    put(dirs.builtinDir, 'commands/c.md', 'cmd');
    expect(exportToGlobal(dirs, backupDir, 'command', 'c')).toBeUndefined();
    expect(read(dirs.globalDir, 'commands/c.md')).toBe('cmd');
    expect(existsSync(backupDir)).toBe(false);
  });

  it('элемента нет ни во встроенном, ни в «моём» — глобальный не трогается', () => {
    put(dirs.globalDir, 'agents/x.md', 'keep');
    expect(exportToGlobal(dirs, backupDir, 'agent', 'x')).toBeUndefined();
    expect(read(dirs.globalDir, 'agents/x.md')).toBe('keep');
  });
});

describe('importFromGlobal', () => {
  it('навык целиком становится копией «моё», прежняя копия — в архиве', () => {
    put(dirs.globalDir, 'skills/s/SKILL.md', 'global main');
    put(dirs.globalDir, 'skills/s/scripts/run.mjs', 'run');
    put(dirs.mineDir, 'skills/s/SKILL.md', 'previous mine');

    expect(importFromGlobal(dirs, archiveDir, 'skill', 's')).toBe(true);

    expect(read(dirs.mineDir, 'skills/s/SKILL.md')).toBe('global main');
    expect(read(dirs.mineDir, 'skills/s/scripts/run.mjs')).toBe('run');
    const [stamp] = readdirSync(archiveDir);
    expect(read(join(archiveDir, stamp!), 'skills/s/SKILL.md')).toBe('previous mine');
  });

  it('в глобальном нет главного файла — отказ, «моё» не тронуто', () => {
    put(dirs.globalDir, 'skills/s/notes.md', 'no main');
    put(dirs.mineDir, 'skills/s/SKILL.md', 'mine');
    expect(importFromGlobal(dirs, archiveDir, 'skill', 's')).toBe(false);
    expect(read(dirs.mineDir, 'skills/s/SKILL.md')).toBe('mine');
    expect(existsSync(archiveDir)).toBe(false);
  });

  it('команда — одним файлом', () => {
    put(dirs.globalDir, 'commands/c.md', 'global cmd');
    expect(importFromGlobal(dirs, archiveDir, 'command', 'c')).toBe(true);
    expect(read(dirs.mineDir, 'commands/c.md')).toBe('global cmd');
  });
});
