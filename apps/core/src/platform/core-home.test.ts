import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostileHomes } from './__fixtures__/hostile-homes.ts';
import { claudeDenyRules } from '../adapters/claude/permission.ts';
import { claudeAbsolutePattern } from '../adapters/claude/path-pattern.ts';
import {
  attachmentsHome,
  CORE_HOME_ENV,
  defaultCoreHome,
  ensureCoreHome,
  homeDenyCatches,
  layoutOf,
  taskDir,
} from './core-home.ts';

/**
 * P78 (00 §Core home, F13): дом ядра — один каталог при любом написании пути. Переменная
 * `AGENTDECK_CORE_HOME` переопределяет его на всех ОС; без неё — `.agentdeck/core` в домашнем
 * каталоге той ОС. Короткое имя 8.3 и длинное приводятся к одному настоящему пути.
 */

const DIRS = [
  'tasks',
  'profiles',
  'scenarios',
  'builds',
  'queue',
  'spool',
  'logs',
  'backups',
] as const;

describe('core home', () => {
  it('P78 the override wins on every OS; a blank override falls back to the OS home', () => {
    expect(defaultCoreHome({ [CORE_HOME_ENV]: 'rel/ядро' }, 'linux')).toBe(resolve('rel/ядро'));
    expect(defaultCoreHome({ [CORE_HOME_ENV]: '  ', HOME: '/home/u' }, 'linux')).toBe(
      join('/home/u', '.agentdeck', 'core'),
    );
    expect(defaultCoreHome({ USERPROFILE: 'C:\\Users\\u', HOME: '/wrong' }, 'win32')).toBe(
      join('C:\\Users\\u', '.agentdeck', 'core'),
    );
    expect(defaultCoreHome({ HOME: '/Users/u', USERPROFILE: 'C:\\wrong' }, 'darwin')).toBe(
      join('/Users/u', '.agentdeck', 'core'),
    );
  });

  it('P78 ensureCoreHome creates every directory and resolves all spellings to one real root', () => {
    const roots = new Map<string, string>();
    for (const { name, dir } of hostileHomes()) {
      const home = join(dir, 'core');
      const layout = ensureCoreHome(home);
      for (const sub of DIRS) {
        expect({ name, sub, dir: statSync(layout[sub]).isDirectory() }).toEqual({
          name,
          sub,
          dir: true,
        });
      }
      expect(layout).toEqual(layoutOf(layout.root));
      expect(taskDir(layout, 'abc')).toBe(join(layout.tasks, 'abc'));
      // Файлы дома (токен, procs.json) создаются их владельцами, а не раскладкой.
      expect(existsSync(layout.token)).toBe(false);
      roots.set(name, layout.root);
      // Повторный вызов на готовом доме ничего не ломает и даёт ту же раскладку.
      expect(ensureCoreHome(home)).toEqual(layout);
    }
    if (process.platform === 'win32') {
      // Короткое имя 8.3 указывает на нелатинский каталог: дом один, а не два журнала задачи.
      expect(roots.get('short-8.3')).toBe(roots.get('non-latin'));
      expect(roots.get('short-8.3')).not.toMatch(/~\d/);
    }
  });
});

describe('attachments root: a sibling the CLI deny of the home never catches (s10 G11)', () => {
  const NONE = { paths: [], commands: [], mcpTools: [], tools: [] };
  // Правила, что уходят CLI для дома, и путь, как его пишет модель.
  const deniedBy = (home: string) => {
    const { rules } = claudeDenyRules({ ...NONE, paths: [home] }, [], home);
    const reads = rules.filter((r) => r.startsWith('Read(')).map((r) => r.slice(5, -1));
    return (path: string): boolean =>
      reads.some((form) => posix.matchesGlob(claudeAbsolutePattern(path), form));
  };
  // Родитель без сегмента на точку: `posix.matchesGlob` не сверяет `*` с именем на точку, а CLI
  // сверяет (живая проба V7) — с `.agentdeck` проверка молча ослабла бы до точной формы.
  const parent = process.platform === 'win32' ? 'C:\\Users\\me\\agentdeck' : '/home/me/agentdeck';

  it.each(['core', 'core-home', 'agentdeck-core', 'attachments-home', 'Core[1]Home', 'дом ядра'])(
    'home %s: copies sit beside it, outside every deny form of it, named by the home',
    (name) => {
      const home = join(parent, name);
      const root = attachmentsHome(home);
      const denied = deniedBy(home);
      expect(denied(join(home, 'tasks', 'x'))).toBe(true);
      expect(denied(join(root, 't1', 'c1', 'shot.png'))).toBe(false);
      expect(dirname(dirname(root))).toBe(parent);
      expect(basename(root)).toBe(name);
    },
  );

  it('the long home of the stand catches the derived names, the picker skips them', () => {
    const home = join(parent, 'core-home');
    const denied = deniedBy(home);
    // Живой отказ стенда (Windows): сосед с буквами дома по порядку — под запретом. Формы,
    // терпимые к 8.3, строятся только для пути с диском/UNC; POSIX-путь их не получает.
    const win = process.platform === 'win32';
    expect(denied(join(parent, 'core-home-attachments', 'x'))).toBe(win);
    expect(denied(join(parent, 'core-attachments', 'x'))).toBe(win);
    expect(homeDenyCatches('core-home', 'core-attachments')).toBe(true);
    expect(homeDenyCatches('core-home', 'agentdeck-attachments')).toBe(false);
    // Дом, чьи буквы ловят первое имя, — второе.
    expect(homeDenyCatches('agentdeck-attachments-x', 'agentdeck-attachments')).toBe(true);
    const fallback = attachmentsHome(join(parent, 'agentdeck-attachments-x'));
    expect(basename(dirname(fallback))).toBe('attachments');
    expect(deniedBy(join(parent, 'agentdeck-attachments-x'))(join(fallback, 'y'))).toBe(false);
  });
});
