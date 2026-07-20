import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readScripts, readScriptContent, saveScript, deleteScript } from './scripts.ts';

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

    it('путь с ../ не выходит за пределы hooks/ (path traversal)', () => {
      // Пытаемся записать за пределы каталога — сегменты .. должны отброситься.
      saveScript(hooksDir, '../../evil.mjs', 'PWNED');

      // Файл не должен появиться выше hooksDir.
      expect(existsSync(join(dir, 'evil.mjs'))).toBe(false);
      expect(existsSync(join(dir, '..', 'evil.mjs'))).toBe(false);
      // Он оседает внутри hooks/ под очищенным именем.
      expect(existsSync(join(hooksDir, 'evil.mjs'))).toBe(true);
    });

    it('чтение по пути с ../ тоже не вырывается наружу', () => {
      writeFileSync(join(dir, 'secret.txt'), 'секрет за пределами');
      // sanitizeRelPath выкидывает .. → путь замыкается внутри hooks/.
      const content = readScriptContent(hooksDir, '../secret.txt');
      expect(content).not.toContain('секрет за пределами');
    });
  });

  describe('deleteScript — удаление', () => {
    it('удаляет скрипт по id', () => {
      writeFileSync(join(hooksDir, 'z.mjs'), '// z');
      deleteScript(hooksDir, 'z.mjs');
      expect(existsSync(join(hooksDir, 'z.mjs'))).toBe(false);
    });

    it('удаление отсутствующего скрипта не бросает', () => {
      expect(() => deleteScript(hooksDir, 'нет.mjs')).not.toThrow();
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
});
