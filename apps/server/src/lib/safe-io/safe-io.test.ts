import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readJsonFile,
  readTextFile,
  writeTextFile,
  writeJsonFile,
  assertValidJson,
} from './safe-io.ts';

/**
 * Тесты файловых операций. Модуль правит рабочий конфиг живого Claude Code,
 * поэтому проверяем именно страховки от потери данных: атомарность записи
 * (прерванная запись не оставляет мусора и обрезанного файла) и резервную
 * копию со СТАРЫМ содержимым перед каждой перезаписью. Плюс устойчивость
 * чтения к пустым/отсутствующим файлам.
 *
 * Каждый тест поднимает свой временный каталог и убирает его за собой —
 * настоящий ~/.claude не затрагивается.
 */
describe('safe-io', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-safeio-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('чтение', () => {
    it('readJsonFile на отсутствующем файле возвращает дефолт', () => {
      // Файла нет — вместо падения отдаём переданный fallback.
      const fallback = { theme: 'dark' };
      expect(readJsonFile(join(dir, 'нет-такого.json'), fallback)).toBe(fallback);
    });

    it('readJsonFile на пустом файле возвращает дефолт', () => {
      // Только что созданный (touch) файл — пустая строка, не ошибка формата.
      const path = join(dir, 'empty.json');
      writeFileSync(path, '   \n');
      expect(readJsonFile(path, { ok: true })).toEqual({ ok: true });
    });

    it('readJsonFile на валидном JSON возвращает разобранный объект', () => {
      const path = join(dir, 'good.json');
      writeFileSync(path, '{"a":1,"b":[2,3]}');
      expect(readJsonFile(path, null)).toEqual({ a: 1, b: [2, 3] });
    });

    it('readJsonFile на битом JSON пробрасывает ошибку разбора', () => {
      // ВНИМАНИЕ: по постановке задачи ожидался возврат дефолта, но реальная
      // реализация НЕ оборачивает JSON.parse в try/catch — на непустом битом
      // содержимом бросает SyntaxError (пустой файл при этом обрабатывается).
      // Фиксируем фактическое поведение; является ли это багом — см. отчёт.
      const path = join(dir, 'broken.json');
      writeFileSync(path, '{ это не json ');
      expect(() => readJsonFile(path, {})).toThrow();
    });

    it('readTextFile отдаёт содержимое существующего файла', () => {
      const path = join(dir, 'note.txt');
      writeFileSync(path, 'привет');
      expect(readTextFile(path)).toBe('привет');
    });

    it('readTextFile на отсутствующем файле возвращает fallback', () => {
      // По умолчанию — пустая строка; можно передать свой дефолт.
      expect(readTextFile(join(dir, 'нет.txt'))).toBe('');
      expect(readTextFile(join(dir, 'нет.txt'), 'default')).toBe('default');
    });
  });

  describe('атомарная запись', () => {
    it('записывает файл с переданным содержимым', () => {
      const path = join(dir, 'a.txt');
      writeTextFile(path, 'content');
      expect(readFileSync(path, 'utf8')).toBe('content');
    });

    it('не оставляет временный .tmp-файл после успешной записи', () => {
      // Пишем во временный файл рядом и переименовываем — по завершении
      // в каталоге должен остаться только целевой файл, без .tmp-мусора.
      writeTextFile(join(dir, 'settings.json'), '{}');
      const entries = readdirSync(dir);
      expect(entries).toContain('settings.json');
      expect(entries.some((name) => name.includes('.tmp-'))).toBe(false);
    });

    it('создаёт недостающие родительские каталоги', () => {
      const nested = join(dir, 'sub', 'deep', 'file.txt');
      writeTextFile(nested, 'x');
      expect(existsSync(nested)).toBe(true);
    });

    it('серия записей в один путь не оставляет .tmp-хвостов, итог — последнее значение', () => {
      // Имя временного файла завязано на pid И монотонный счётчик, поэтому
      // каждая запись берёт собственный tmp — соседние записи не наступают на
      // промежуточный файл друг друга и не оставляют мусор.
      const path = join(dir, 'settings.json');
      for (let i = 0; i < 25; i += 1) writeTextFile(path, `v${i}`);

      expect(readFileSync(path, 'utf8')).toBe('v24');
      expect(readdirSync(dir).some((name) => name.includes('.tmp-'))).toBe(false);
    });
  });

  describe('резервные копии', () => {
    it('первая запись (файла ещё нет) копию не создаёт', () => {
      // Бэкапить нечего — makeBackup выходит до создания каталога копий.
      const path = join(dir, 'settings.json');
      const backupDir = join(dir, 'backups');
      const backup = writeTextFile(path, 'первое', { backupDir });
      expect(backup).toBeUndefined();
      expect(existsSync(backupDir)).toBe(false);
    });

    it('перезапись существующего файла создаёт бэкап в backupDir', () => {
      const path = join(dir, 'settings.json');
      const backupDir = join(dir, 'backups');
      writeTextFile(path, 'старое', { backupDir }); // копии нет
      const backup = writeTextFile(path, 'новое', { backupDir }); // копия старого
      expect(backup).toBeDefined();
      expect(existsSync(backup!)).toBe(true);
      // В каталоге копий ровно один .bak.
      expect(readdirSync(backupDir).filter((n) => n.endsWith('.bak'))).toHaveLength(1);
    });

    it('бэкап содержит СТАРОЕ содержимое, а целевой файл — новое', () => {
      // Ключевая гарантия: если перезапись испортит данные, старая версия
      // осталась в копии до перезаписи.
      const path = join(dir, 'settings.json');
      const backupDir = join(dir, 'backups');
      writeTextFile(path, 'ВЕРСИЯ-1', { backupDir });
      const backup = writeTextFile(path, 'ВЕРСИЯ-2', { backupDir });
      expect(readFileSync(backup!, 'utf8')).toBe('ВЕРСИЯ-1');
      expect(readFileSync(path, 'utf8')).toBe('ВЕРСИЯ-2');
    });

    it('без backupDir копии не делаются', () => {
      const path = join(dir, 'settings.json');
      writeTextFile(path, 'v1');
      const backup = writeTextFile(path, 'v2');
      expect(backup).toBeUndefined();
    });
  });

  describe('writeJsonFile', () => {
    it('сериализует объект с отступом 2 и финальным переводом строки', () => {
      const path = join(dir, 'data.json');
      writeJsonFile(path, { b: 2, a: 1 });
      // JSON.stringify(data, null, 2) сохраняет порядок ключей + '\n' в конце.
      expect(readFileSync(path, 'utf8')).toBe('{\n  "b": 2,\n  "a": 1\n}\n');
    });

    it('записанный объект читается обратно без потерь', () => {
      const path = join(dir, 'roundtrip.json');
      const value = { nested: { list: [1, 2, 3], flag: true }, name: 'скилл' };
      writeJsonFile(path, value);
      expect(readJsonFile(path, null)).toEqual(value);
    });

    it('прокидывает бэкап старой версии при перезаписи', () => {
      const path = join(dir, 'settings.json');
      const backupDir = join(dir, 'backups');
      writeJsonFile(path, { version: 1 }, { backupDir });
      const backup = writeJsonFile(path, { version: 2 }, { backupDir });
      expect(backup).toBeDefined();
      expect(JSON.parse(readFileSync(backup!, 'utf8'))).toEqual({ version: 1 });
    });
  });

  // На Windows chmod управляет только флагом «только чтение», прав POSIX там нет —
  // проверять нечего, поэтому блок пропускается целиком.
  describe.skipIf(process.platform === 'win32')('права доступа', () => {
    it('перезапись не сбрасывает права существующего файла', () => {
      const path = join(dir, 'settings.json');
      writeFileSync(path, '{}', { mode: 0o600 });
      writeJsonFile(path, { version: 2 });
      // Запись идёт через временный файл + rename: без восстановления режима
      // файл стал бы 0644 (umask), то есть читаемым для всех.
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('новый файл секретов создаётся с 0600', () => {
      const path = join(dir, '.credentials.json');
      writeJsonFile(path, { claudeAiOauth: { accessToken: 'секрет' } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('обычный новый файл права не ужимает', () => {
      const path = join(dir, 'settings.json');
      writeJsonFile(path, { version: 1 });
      expect(statSync(path).mode & 0o600).toBe(0o600);
    });
  });

  describe('assertValidJson', () => {
    it('валидный JSON проходит без исключения', () => {
      expect(() => assertValidJson('{"a":1}')).not.toThrow();
    });

    it('битый JSON бросает ошибку с русским пояснением', () => {
      // Проверка используется перед записью, чтобы не портить конфиг.
      expect(() => assertValidJson('{ битый ')).toThrow(/Невалидный JSON/);
    });
  });
});
