import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hostileHomes } from './__fixtures__/hostile-homes.ts';
import { CORE_HOME_ENV, defaultCoreHome, ensureCoreHome, layoutOf, taskDir } from './core-home.ts';

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
