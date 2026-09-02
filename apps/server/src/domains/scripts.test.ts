import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readScripts,
  readScriptContent,
  saveScript,
  createScript,
  deleteScript,
  UnsafeScriptPathError,
  ScriptNotFoundError,
  ScriptExistsError,
} from './scripts.ts';

/**
 * Тесты скриптов из каталога hooks/. Важное здесь:
 *   - рекурсивный обход подпапок и id = относительный путь с прямыми слэшами;
 *   - «используется ли скрипт» — по совпадению с путями, прописанными в хуках;
 *   - защита от выхода за пределы каталога (path traversal) при чтении/записи;
 *   - создание вложенных папок при сохранении.
 *
 * Всё пишется во временный каталог из mkdtempSync — настоящий ~/.claude/hooks
 * не затрагивается. Каждый тест убирает свой каталог за собой.
 */
describe('scripts', () => {
  let dir: string;
  let hooksDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-scripts-'));
    hooksDir = join(dir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readScripts — обход каталога', () => {
    it('несуществующий каталог даёт пустой список, а не падение', () => {
      expect(readScripts(join(dir, 'нет-такого'), [])).toEqual([]);
    });

    it('находит скрипты только с известными расширениями', () => {
      writeFileSync(join(hooksDir, 'a.mjs'), '// a');
      writeFileSync(join(hooksDir, 'b.sh'), '# b');
      writeFileSync(join(hooksDir, 'c.py'), '# c');
      writeFileSync(join(hooksDir, 'readme.md'), 'not a script');
      writeFileSync(join(hooksDir, 'data.json'), '{}');

      const ids = readScripts(hooksDir, []).map((s) => s.id);

      expect(ids).toEqual(['a.mjs', 'b.sh', 'c.py']);
    });

    it('заходит в подпапки, id — относительный путь с прямыми слэшами', () => {
      mkdirSync(join(hooksDir, 'sub', 'deep'), { recursive: true });
      writeFileSync(join(hooksDir, 'top.mjs'), '// top');
      writeFileSync(join(hooksDir, 'sub', 'mid.mjs'), '// mid');
      writeFileSync(join(hooksDir, 'sub', 'deep', 'low.mjs'), '// low');

      const scripts = readScripts(hooksDir, []);
      const byId = Object.fromEntries(scripts.map((s) => [s.id, s]));

      expect(scripts.map((s) => s.id)).toEqual(['sub/deep/low.mjs', 'sub/mid.mjs', 'top.mjs']);
      // Для вложенного скрипта показываем путь целиком (name === id).
      expect(byId['sub/mid.mjs']?.name).toBe('sub/mid.mjs');
      // extension считается по имени файла, а не по всему пути.
      expect(byId['sub/mid.mjs']?.extension).toBe('.mjs');
    });

    it('пропускает node_modules и скрытые каталоги', () => {
      mkdirSync(join(hooksDir, 'node_modules'), { recursive: true });
      mkdirSync(join(hooksDir, '.cache'), { recursive: true });
      writeFileSync(join(hooksDir, 'node_modules', 'dep.mjs'), '// dep');
      writeFileSync(join(hooksDir, '.cache', 'x.mjs'), '// x');
      writeFileSync(join(hooksDir, 'real.mjs'), '// real');

      expect(readScripts(hooksDir, []).map((s) => s.id)).toEqual(['real.mjs']);
    });

    it('вытаскивает описание из шапки комментария, пропуская shebang', () => {
      writeFileSync(
        join(hooksDir, 'guard.mjs'),
        '#!/usr/bin/env node\n// Блокирует опасные команды.\n// Вторая строка.\n\ncode();\n',
      );
      writeFileSync(join(hooksDir, 'sh.sh'), '#!/bin/sh\n# Описание shell-скрипта.\n\necho ok\n');

      const scripts = readScripts(hooksDir, []);
      expect(scripts.find((s) => s.id === 'guard.mjs')?.description).toBe(
        'Блокирует опасные команды. Вторая строка.',
      );
      expect(scripts.find((s) => s.id === 'sh.sh')?.description).toBe('Описание shell-скрипта.');
    });
  });

  describe('readScripts — признак «используется»', () => {
    it('точное совпадение по относительному пути помечает скрипт используемым', () => {
      mkdirSync(join(hooksDir, 'sub'), { recursive: true });
      writeFileSync(join(hooksDir, 'sub', 'used.mjs'), '// used');
      writeFileSync(join(hooksDir, 'free.mjs'), '// free');

      const scripts = readScripts(hooksDir, ['C:/Users/me/.claude/hooks/sub/used.mjs']);
      const byId = Object.fromEntries(scripts.map((s) => [s.id, s]));

      expect(byId['sub/used.mjs']?.isUsed).toBe(true);
      expect(byId['free.mjs']?.isUsed).toBe(false);
    });

    it('нормализует обратные слэши в путях из конфига', () => {
      writeFileSync(join(hooksDir, 'win.mjs'), '// win');

      const scripts = readScripts(hooksDir, ['C:\\Users\\me\\.claude\\hooks\\win.mjs']);
      expect(scripts.find((s) => s.id === 'win.mjs')?.isUsed).toBe(true);
    });

    it('запасное совпадение по имени файла, если путь в конфиге относительный', () => {
      writeFileSync(join(hooksDir, 'byname.mjs'), '// byname');

      // В конфиге путь без каталога — сработать должно совпадение по имени.
      expect(readScripts(hooksDir, ['byname.mjs'])[0]?.isUsed).toBe(true);
    });

    /**
     * BUG (см. .agent/tmp/audit-config.md → BUG-3). «Используется» вычисляется
     * через `used.endsWith(rel)` без границы сегмента пути. Поэтому скрипт
     * `check.mjs` считается используемым, если хук ссылается на `precheck.mjs`
     * (или на `.../othersub/check.mjs` при rel `sub/check.mjs`). Тест фиксирует
     * ЖЕЛАЕМОЕ поведение и включится после фикса (сравнение по сегментам пути).
     */
    it('НЕ помечает check.mjs используемым, когда используется только precheck.mjs (BUG-3)', () => {
      writeFileSync(join(hooksDir, 'check.mjs'), '// check');
      writeFileSync(join(hooksDir, 'precheck.mjs'), '// precheck');

      const scripts = readScripts(hooksDir, ['C:/Users/me/.claude/hooks/precheck.mjs']);
      const byId = Object.fromEntries(scripts.map((s) => [s.id, s]));

      expect(byId['precheck.mjs']?.isUsed).toBe(true);
      expect(byId['check.mjs']?.isUsed).toBe(false);
    });

    it('суффикс пути без границы сегмента больше не считается совпадением (BUG-3)', () => {
      writeFileSync(join(hooksDir, 'deploy.mjs'), '// deploy');

      // Хук ссылается на другой файл, чьё имя лишь ЗАКАНЧИВАЕТСЯ на «deploy.mjs».
      // Имена различаются, поэтому запасное совпадение по имени не срабатывает —
      // остаётся ровно проверка границы сегмента пути.
      const scripts = readScripts(hooksDir, ['C:/Users/me/.claude/hooks/predeploy.mjs']);

      expect(scripts.find((s) => s.id === 'deploy.mjs')?.isUsed).toBe(false);
    });
  });

  describe('readScripts — импорты используемых скриптов', () => {
    const hooked = ['C:/Users/me/.claude/hooks/dispatch.mjs'];

    it('модуль, который импортирует привязанный скрипт, тоже используется', () => {
      mkdirSync(join(hooksDir, 'lib'), { recursive: true });
      writeFileSync(
        join(hooksDir, 'dispatch.mjs'),
        "import { run } from './lib/guard.mjs';\nrun();\n",
      );
      writeFileSync(join(hooksDir, 'lib', 'guard.mjs'), 'export const run = () => {};\n');
      writeFileSync(join(hooksDir, 'lib', 'orphan.mjs'), 'export const x = 1;\n');

      const byId = Object.fromEntries(readScripts(hooksDir, hooked).map((s) => [s.id, s]));

      expect(byId['lib/guard.mjs']?.isUsed).toBe(true);
      expect(byId['lib/orphan.mjs']?.isUsed).toBe(false);
    });

    it('идёт по цепочке импортов и понимает import()/require', () => {
      mkdirSync(join(hooksDir, 'lib'), { recursive: true });
      writeFileSync(join(hooksDir, 'dispatch.mjs'), "const m = await import('./lib/a.mjs');\n");
      writeFileSync(join(hooksDir, 'lib', 'a.mjs'), "import './b.mjs';\n");
      writeFileSync(join(hooksDir, 'lib', 'b.mjs'), "const c = require('../c.cjs');\n");
      writeFileSync(join(hooksDir, 'c.cjs'), 'module.exports = {};\n');

      const byId = Object.fromEntries(readScripts(hooksDir, hooked).map((s) => [s.id, s]));

      expect(byId['lib/a.mjs']?.isUsed).toBe(true);
      expect(byId['lib/b.mjs']?.isUsed).toBe(true);
      expect(byId['c.cjs']?.isUsed).toBe(true);
    });

    it('импорт из НЕпривязанного файла (тест) модуль используемым не делает', () => {
      mkdirSync(join(hooksDir, 'lib'), { recursive: true });
      mkdirSync(join(hooksDir, 'tests'), { recursive: true });
      writeFileSync(join(hooksDir, 'dispatch.mjs'), '// no imports\n');
      writeFileSync(join(hooksDir, 'lib', 'helper.mjs'), 'export const h = 1;\n');
      writeFileSync(join(hooksDir, 'tests', 'helper.test.mjs'), "import '../lib/helper.mjs';\n");

      const byId = Object.fromEntries(readScripts(hooksDir, hooked).map((s) => [s.id, s]));

      expect(byId['dispatch.mjs']?.isUsed).toBe(true);
      expect(byId['lib/helper.mjs']?.isUsed).toBe(false);
      expect(byId['tests/helper.test.mjs']?.isUsed).toBe(false);
    });

    it('пакеты и импорты за пределы каталога не ломают разбор', () => {
      writeFileSync(
        join(hooksDir, 'dispatch.mjs'),
        "import fs from 'node:fs';\nimport x from 'some-package';\nimport y from '../../outside.mjs';\n",
      );
      writeFileSync(join(hooksDir, 'free.mjs'), '// free\n');

      const byId = Object.fromEntries(readScripts(hooksDir, hooked).map((s) => [s.id, s]));

      expect(byId['dispatch.mjs']?.isUsed).toBe(true);
      expect(byId['free.mjs']?.isUsed).toBe(false);
    });
  });

  describe('readScriptContent / saveScript — чтение и запись', () => {
    it('читает содержимое скрипта по id', () => {
      writeFileSync(join(hooksDir, 'x.mjs'), 'const a = 1;\n');
      expect(readScriptContent(hooksDir, 'x.mjs')).toBe('const a = 1;\n');
    });

    it('сохраняет новый скрипт и создаёт вложенные папки', () => {
      saveScript(hooksDir, 'nested/deep/new.mjs', '// новый\n');

      const target = join(hooksDir, 'nested', 'deep', 'new.mjs');
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('// новый\n');
    });

    it('перезаписывает существующий скрипт и делает резервную копию', () => {
      const backupDir = join(dir, 'backups');
      writeFileSync(join(hooksDir, 'y.mjs'), 'old');

      const backup = saveScript(hooksDir, 'y.mjs', 'new', backupDir);

      expect(readScriptContent(hooksDir, 'y.mjs')).toBe('new');
      expect(backup).toBeTypeOf('string');
      expect(existsSync(backup as string)).toBe(true);
    });

    /**
     * BUG-7. Id — это НАСТОЯЩИЙ относительный путь из readScripts. Пока сегменты
     * чистились до [a-zA-Z0-9._-], `my script.mjs` читался как `myscript.mjs`
     * (пустой редактор), сохранение создавало чужой файл, а настоящий хук
     * оставался со старым кодом.
     */
    it('читает и перезаписывает файл с пробелом в имени, а не соседний (BUG-7)', () => {
      writeFileSync(join(hooksDir, 'my script.mjs'), 'старое');
      writeFileSync(join(hooksDir, 'myscript.mjs'), 'сосед');

      expect(readScriptContent(hooksDir, 'my script.mjs')).toBe('старое');

      saveScript(hooksDir, 'my script.mjs', 'новое');

      expect(readFileSync(join(hooksDir, 'my script.mjs'), 'utf8')).toBe('новое');
      expect(readFileSync(join(hooksDir, 'myscript.mjs'), 'utf8')).toBe('сосед');
    });

    it('кириллическое имя не схлопывается в .mjs (BUG-7)', () => {
      writeFileSync(join(hooksDir, 'проверка.mjs'), '// проверка');

      expect(readScriptContent(hooksDir, 'проверка.mjs')).toBe('// проверка');

      saveScript(hooksDir, 'вложенная папка/проверка.mjs', '// вложенный');

      expect(readFileSync(join(hooksDir, 'вложенная папка', 'проверка.mjs'), 'utf8')).toBe(
        '// вложенный',
      );
      expect(existsSync(join(hooksDir, '.mjs'))).toBe(false);
    });

    it('id из readScripts всегда открывает тот же файл (BUG-7)', () => {
      mkdirSync(join(hooksDir, 'под папка'), { recursive: true });
      writeFileSync(join(hooksDir, 'под папка', 'хук №1.mjs'), 'содержимое');

      const id = readScripts(hooksDir, [])[0]?.id as string;

      expect(readScriptContent(hooksDir, id)).toBe('содержимое');
    });

    it('путь с ../ отклоняется, а не «очищается» (path traversal)', () => {
      // Молча писать по другому пути нельзя: это и есть BUG-7 в другой одежде.
      expect(() => saveScript(hooksDir, '../../evil.mjs', 'PWNED')).toThrow(UnsafeScriptPathError);

      expect(existsSync(join(dir, 'evil.mjs'))).toBe(false);
      expect(existsSync(join(hooksDir, 'evil.mjs'))).toBe(false);
    });

    it('чтение по пути с ../ тоже не вырывается наружу', () => {
      writeFileSync(join(dir, 'secret.txt'), 'секрет за пределами');

      expect(() => readScriptContent(hooksDir, '../secret.txt')).toThrow(UnsafeScriptPathError);
    });

    it('абсолютный путь и пустой id отклоняются', () => {
      expect(() => readScriptContent(hooksDir, '/etc/passwd')).toThrow(UnsafeScriptPathError);
      expect(() => readScriptContent(hooksDir, 'C:/Windows/win.ini')).toThrow(
        UnsafeScriptPathError,
      );
      expect(() => saveScript(hooksDir, '', 'x')).toThrow(UnsafeScriptPathError);
    });
  });

  describe('deleteScript — удаление', () => {
    it('удаляет скрипт по id', () => {
      writeFileSync(join(hooksDir, 'z.mjs'), '// z');
      deleteScript(hooksDir, 'z.mjs');
      expect(existsSync(join(hooksDir, 'z.mjs'))).toBe(false);
    });

    /**
     * BUG-24. Раньше отсутствующий файл давал тихий `undefined`, а маршрут
     * отвечал `{ok:true}` — панель рапортовала «удалено», хотя не удалила
     * ничего. Теперь это отказ с 404: пользователь видит настоящее положение
     * дел, а не выдуманный успех.
     */
    it('удаление отсутствующего скрипта — честный отказ 404, а не мнимый успех (BUG-24)', () => {
      expect(() => deleteScript(hooksDir, 'нет.mjs')).toThrow(ScriptNotFoundError);

      let statusCode: number | undefined;
      try {
        deleteScript(hooksDir, 'нет.mjs');
      } catch (error) {
        statusCode = (error as { statusCode?: number }).statusCode;
      }
      expect(statusCode).toBe(404);
    });

    it('чтение отсутствующего скрипта тоже отказ, а не пустой редактор (BUG-24)', () => {
      // Пустая строка выглядела бы как «скрипт пустой», и сохранение создало бы
      // файл заново вместо правки того, за которым пришли.
      expect(() => readScriptContent(hooksDir, 'нет.mjs')).toThrow(ScriptNotFoundError);
    });

    it('удаляет скрипт с кириллицей в имени по-настоящему (BUG-24)', () => {
      // rmSync на кириллическом пути в Windows умеет рапортовать об успехе,
      // ничего не удалив, — удаление идёт через removeEntry из safe-io.
      writeFileSync(join(hooksDir, 'проверка хуков.mjs'), '// проверка');

      deleteScript(hooksDir, 'проверка хуков.mjs');

      expect(existsSync(join(hooksDir, 'проверка хуков.mjs'))).toBe(false);
    });

    it('удаляет вложенный скрипт, не задевая соседей', () => {
      mkdirSync(join(hooksDir, 'sub'), { recursive: true });
      writeFileSync(join(hooksDir, 'sub', 'a.mjs'), '// a');
      writeFileSync(join(hooksDir, 'sub', 'b.mjs'), '// b');

      deleteScript(hooksDir, 'sub/a.mjs');

      expect(existsSync(join(hooksDir, 'sub', 'a.mjs'))).toBe(false);
      expect(existsSync(join(hooksDir, 'sub', 'b.mjs'))).toBe(true);
    });

    /**
     * BUG (см. .agent/tmp/audit-config.md → BUG-1). Раньше deleteScript стирал
     * файл без резервной копии — в отличие от deleteSkill. Теперь при заданном
     * backupDir снимается копия, и её путь возвращается (для ответа маршрута).
     */
    it('снимает резервную копию перед удалением и возвращает её путь (BUG-1)', () => {
      const backupDir = join(dir, 'backups');
      writeFileSync(join(hooksDir, 'w.mjs'), 'важное содержимое');

      const backup = deleteScript(hooksDir, 'w.mjs', backupDir);

      expect(existsSync(join(hooksDir, 'w.mjs'))).toBe(false);
      expect(backup).toBeTypeOf('string');
      expect(existsSync(backup as string)).toBe(true);
      // Копия хранит исходное содержимое — удаление обратимо.
      expect(readFileSync(backup as string, 'utf8')).toBe('важное содержимое');
    });

    it('без backupDir удаляет и возвращает undefined (копий не делает)', () => {
      writeFileSync(join(hooksDir, 'nobackup.mjs'), '// x');

      const backup = deleteScript(hooksDir, 'nobackup.mjs');

      expect(existsSync(join(hooksDir, 'nobackup.mjs'))).toBe(false);
      expect(backup).toBeUndefined();
    });
  });

  /**
   * Аудит страницы 2026-09-02. Имя, под которым файл не попадёт в список, или
   * которое Windows не примет, раньше доходило до записи: «Сохранено» — и пустота
   * в списке, либо 500 посреди rename и лишний файл в папке.
   */
  describe('resolveScriptPath — имена, которые нельзя принимать', () => {
    it('без расширения скрипта и из одного расширения — 400, файла нет', () => {
      expect(() => saveScript(hooksDir, 'sub/noext', 'x')).toThrow(UnsafeScriptPathError);
      expect(() => saveScript(hooksDir, 'sub/.mjs', 'x')).toThrow(UnsafeScriptPathError);
      expect(() => saveScript(hooksDir, 'notes.txt', 'x')).toThrow(UnsafeScriptPathError);
      expect(existsSync(join(hooksDir, 'sub'))).toBe(false);
    });

    it('символы, запрещённые в Windows, — 400 на любой системе', () => {
      for (const bad of ['bad:name.mjs', 'a<b.mjs', 'q?.mjs', 'pipe|x.sh']) {
        expect(() => saveScript(hooksDir, bad, 'x')).toThrow(UnsafeScriptPathError);
      }
      expect(existsSync(join(hooksDir, 'bad'))).toBe(false);
    });

    it('.mts и .cts — скрипты: перечисляются и открываются', () => {
      writeFileSync(join(hooksDir, 'mod.mts'), '// Модуль .mts\nexport {};\n');
      writeFileSync(join(hooksDir, 'common.cts'), '// Модуль .cts\n');

      const ids = readScripts(hooksDir, []).map((s) => s.id);
      expect(ids).toEqual(['common.cts', 'mod.mts']);
      expect(readScriptContent(hooksDir, 'mod.mts')).toContain('.mts');
    });
  });

  describe('createScript — только новый файл', () => {
    it('существующее имя — ScriptExistsError, содержимое не тронуто', () => {
      writeFileSync(join(hooksDir, 'session-brief.mjs'), 'настоящий');

      expect(() => createScript(hooksDir, 'session-brief.mjs', 'заготовка')).toThrow(
        ScriptExistsError,
      );
      expect(readFileSync(join(hooksDir, 'session-brief.mjs'), 'utf8')).toBe('настоящий');
    });

    it('новое имя создаёт файл вместе с вложенными папками', () => {
      createScript(hooksDir, 'new/dir/fresh.mjs', '// новый\n');
      expect(readFileSync(join(hooksDir, 'new', 'dir', 'fresh.mjs'), 'utf8')).toBe('// новый\n');
    });
  });

  describe('readScripts — тесты и описание', () => {
    it('tests/ и *.test.* помечены isTest; остальные — нет', () => {
      mkdirSync(join(hooksDir, 'tests'), { recursive: true });
      mkdirSync(join(hooksDir, 'lib'), { recursive: true });
      writeFileSync(join(hooksDir, 'tests', 'guard.test.mjs'), '');
      writeFileSync(join(hooksDir, 'tests', 'all.mjs'), '');
      writeFileSync(join(hooksDir, 'lib', 'x.spec.ts'), '');
      writeFileSync(join(hooksDir, 'lib', 'x.ts'), '');
      writeFileSync(join(hooksDir, 'guard.mjs'), '');

      const byId = new Map(readScripts(hooksDir, []).map((s) => [s.id, s.isTest]));
      expect(byId.get('tests/guard.test.mjs')).toBe(true);
      expect(byId.get('tests/all.mjs')).toBe(true);
      expect(byId.get('lib/x.spec.ts')).toBe(true);
      expect(byId.get('lib/x.ts')).toBe(false);
      expect(byId.get('guard.mjs')).toBe(false);
    });

    it('описание из блочного комментария — без хвоста « /»', () => {
      writeFileSync(
        join(hooksDir, 'doc.mjs'),
        '#!/usr/bin/env node\n/**\n * Описание модуля.\n */\nexport {};\n',
      );
      expect(readScripts(hooksDir, []).find((s) => s.id === 'doc.mjs')?.description).toBe(
        'Описание модуля.',
      );
    });
  });
});
