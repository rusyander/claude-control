import { describe, it, expect, afterEach } from 'vitest';
import {
  safeSessionId,
  safeModel,
  safeName,
  safePluginId,
  quoteForShell,
  shellArgs,
} from './cli-args.ts';

/**
 * Тесты защиты аргументов командной строки. Это модуль безопасности: значения
 * из запроса уходят в spawn с shell на Windows, где оболочка сама разбирает
 * строку. Поэтому здесь закреплены и допустимые значения, и НЕЙТРАЛИЗАЦИЯ атак
 * (инъекция команд через метасимволы). Тест-кейсы см.
 * .agent/TEST-CASES.md → «Аргументы командной строки (безопасность)».
 */
describe('cli-args', () => {
  describe('safeSessionId — только UUID-подобные идентификаторы', () => {
    it('пропускает валидный id сессии', () => {
      expect(safeSessionId('a1b2c3d4-5678-90ab-cdef-1234567890ab')).toBe(
        'a1b2c3d4-5678-90ab-cdef-1234567890ab',
      );
    });

    it('отбрасывает id с метасимволами оболочки', () => {
      expect(safeSessionId('id & calc')).toBeUndefined();
      expect(safeSessionId('$(rm -rf /)')).toBeUndefined();
      expect(safeSessionId('a;b')).toBeUndefined();
    });

    it('пустое/undefined → undefined', () => {
      expect(safeSessionId('')).toBeUndefined();
      expect(safeSessionId(undefined)).toBeUndefined();
    });
  });

  describe('safeModel — имя модели по белому списку', () => {
    it('пропускает реальные имена моделей, в т.ч. с суффиксом в скобках', () => {
      expect(safeModel('claude-opus-4-8')).toBe('claude-opus-4-8');
      expect(safeModel('claude-sonnet-5')).toBe('claude-sonnet-5');
      expect(safeModel('claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
    });

    it('пропускает имена моделей контура — с двоеточием и косой', () => {
      // Найдено живым прогоном 12.09.2026: `qwen2.5:7b` не проходил белый
      // список, и модель контура молча не доезжала до `--model` — прогон уходил
      // с моделью, которую CLI выберет сам.
      expect(safeModel('qwen2.5:7b')).toBe('qwen2.5:7b');
      expect(safeModel('vendor/gpt-4o')).toBe('vendor/gpt-4o');
    });

    it('пропускает версию модели через @ и длинный ARN профиля вывода', () => {
      // Ревью Т6 (m1): соседи починенного дефекта. Имя панель не придумывает —
      // она предлагает то, что прислал каталог контура, и выброшенное имя
      // означает прогон чужой моделью без единой строки на экране.
      expect(safeModel('gemini-1.5-pro@002')).toBe('gemini-1.5-pro@002');
      const arn =
        'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-5-v1:0';
      expect(safeModel(arn)).toBe(arn);
    });

    it('отбрасывает имя с пробелом или инъекцией', () => {
      expect(safeModel('opus & calc')).toBeUndefined();
      expect(safeModel('model`whoami`')).toBeUndefined();
      // Двоеточие пустило в список ещё и это — проверяем, что не пустило:
      // оболочка cmd.exe склеивает аргументы обратно в строку.
      expect(safeModel('opus|calc')).toBeUndefined();
      expect(safeModel('opus>out.txt')).toBeUndefined();
    });
  });

  describe('safeName — имя чата: метасимволы заменяются, текст остаётся', () => {
    it('обычное имя проходит как есть', () => {
      expect(safeName('Разбор отчёта за июль')).toBe('Разбор отчёта за июль');
    });

    it('нейтрализует инъекцию, сохраняя читаемый остаток', () => {
      // Ключевое: & и calc не должны стать исполняемой командой.
      const cleaned = safeName('отчёт & calc &');
      expect(cleaned).not.toContain('&');
      expect(cleaned).toBe('отчёт calc');
    });

    it('схлопывает пробелы и режет длину до 120', () => {
      expect(safeName('a   b')).toBe('a b');
      expect(safeName('x'.repeat(200))?.length).toBe(120);
    });

    it('имя из одних метасимволов → undefined (пусто после чистки)', () => {
      expect(safeName('&|<>^')).toBeUndefined();
      expect(safeName('')).toBeUndefined();
      expect(safeName(undefined)).toBeUndefined();
    });
  });

  describe('safePluginId — бросает, а не молчит', () => {
    it('пропускает id с маркетплейсом через @ и /', () => {
      expect(safePluginId('my-plugin')).toBe('my-plugin');
      expect(safePluginId('org/plugin@market')).toBe('org/plugin@market');
    });

    it('на недопустимом id бросает ошибку (установка «почти того» хуже)', () => {
      expect(() => safePluginId('plugin & calc')).toThrow();
      expect(() => safePluginId('$(evil)')).toThrow();
    });
  });

  describe('quoteForShell — квотирование под оболочку Windows', () => {
    it('пустая строка становится парой кавычек', () => {
      expect(quoteForShell('')).toBe('""');
    });

    it('простое значение без спецсимволов не квотируется', () => {
      expect(quoteForShell('claude-opus-4-8')).toBe('claude-opus-4-8');
    });

    it('путь с пробелом берётся в кавычки целиком', () => {
      expect(quoteForShell('C:\\Program Files\\node\\x.mjs')).toBe(
        '"C:\\Program Files\\node\\x.mjs"',
      );
    });

    /**
     * Раньше кавычка гасилась слэшем (`\"`) — это правило C-рантайма, а cmd.exe
     * его не знает и считает такую кавычку ЗАКРЫВАЮЩЕЙ. Промпт
     * `a" & echo INJECTED & "b` выходил из кавычек, и вторая команда выполнялась
     * правами сервера (проверено запуском на Windows). cmd.exe понимает удвоение.
     */
    it('внутренняя кавычка удваивается, а не гасится слэшем', () => {
      expect(quoteForShell('a"b')).toBe('"a""b"');
      expect(quoteForShell('a" & echo INJECTED & "b')).not.toContain('\\"');
    });

    /**
     * Хвостовой обратный слэш перед закрывающей кавычкой съел бы её и разомкнул
     * строку — путь вида `C:\каталог\` в аргументе встречается сплошь и рядом.
     */
    it('хвостовые обратные слэши удваиваются', () => {
      expect(quoteForShell('C:\\путь с пробелом\\')).toBe('"C:\\путь с пробелом\\\\"');
    });
  });

  describe('shellArgs — квотирование только на Windows', () => {
    const realPlatform = process.platform;

    afterEach(() => {
      // Возвращаем настоящую платформу после подмены.
      Object.defineProperty(process, 'platform', { value: realPlatform });
    });

    it('undefined → пустой массив', () => {
      expect(shellArgs(undefined)).toEqual([]);
    });

    it('на win32 аргументы с пробелами квотируются', () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      expect(shellArgs(['--name', 'C:\\Program Files\\x'])).toEqual([
        '--name',
        '"C:\\Program Files\\x"',
      ]);
    });

    it('на не-Windows аргументы остаются как есть', () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      expect(shellArgs(['--name', 'a b'])).toEqual(['--name', 'a b']);
    });
  });
});
