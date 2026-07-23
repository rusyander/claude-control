import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffLines, buildHistory, buildDiff } from './history.ts';

/**
 * История изменений — лента правок из резервных копий с построчным диффом.
 *
 * Проверяем три вещи: чистый LCS-дифф (добавление/удаление/без изменений и
 * счётчики), сборку ленты из копий во времени (кто с чем сравнивается) и
 * безопасность — имя копии приходит из запроса, `../` не должен читать чужой
 * файл, а посторонние файлы в каталоге копий в ленту не попадают.
 */

describe('История изменений', () => {
  describe('построчный дифф (diffLines)', () => {
    it('добавленные строки считаются и помечаются add', () => {
      const result = diffLines('a\nb', 'a\nb\nc');
      expect(result.added).toBe(1);
      expect(result.removed).toBe(0);
      expect(result.lines.filter((line) => line.kind === 'add')).toEqual([
        { kind: 'add', text: 'c' },
      ]);
    });

    it('удалённые строки считаются и помечаются del', () => {
      const result = diffLines('a\nb\nc', 'a\nc');
      expect(result.removed).toBe(1);
      expect(result.added).toBe(0);
      expect(result.lines.filter((line) => line.kind === 'del')).toEqual([
        { kind: 'del', text: 'b' },
      ]);
    });

    it('идентичный текст — ноль изменений, все строки ctx', () => {
      const result = diffLines('a\nb\nc', 'a\nb\nc');
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
      expect(result.lines.every((line) => line.kind === 'ctx')).toBe(true);
    });

    it('замена строки — это удаление плюс добавление', () => {
      const result = diffLines('a\nb\nc', 'a\nX\nc');
      expect(result.added).toBe(1);
      expect(result.removed).toBe(1);
    });

    it('разница только в концах строк (CRLF/LF) диффом не считается', () => {
      const result = diffLines('a\r\nb\r\n', 'a\nb\n');
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('завершающий перевод строки не даёт фантомной пустой строки', () => {
      const result = diffLines('a\nb', 'a\nb\n');
      expect(result.added).toBe(0);
      expect(result.removed).toBe(0);
    });

    it('от пустого к тексту — всё добавлено', () => {
      const result = diffLines('', 'a\nb');
      expect(result.added).toBe(2);
      expect(result.removed).toBe(0);
    });
  });

  describe('сборка ленты и дифф копий', () => {
    let dir: string;
    let backupDir: string;
    let settingsPath: string;
    let knownPaths: Record<string, string>;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-history-'));
      backupDir = join(dir, 'backups');
      settingsPath = join(dir, 'settings.json');
      mkdirSync(backupDir, { recursive: true });

      // Текущий файл на диске — состояние ПОСЛЕ последней правки.
      writeFileSync(settingsPath, 'line1\nline2\nline3\n');
      // Две копии во времени: старая и свежая (снимались перед записями).
      writeFileSync(join(backupDir, 'settings.json.2026-07-19T09-00-00-000Z.bak'), 'line1\n');
      writeFileSync(
        join(backupDir, 'settings.json.2026-07-19T10-00-00-000Z.bak'),
        'line1\nline2\n',
      );

      knownPaths = { settings: settingsPath };
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('запись на каждую копию, свежие сверху', () => {
      const items = buildHistory(backupDir, knownPaths);
      expect(items).toHaveLength(2);
      expect(new Date(items[0]!.at).getTime()).toBeGreaterThanOrEqual(
        new Date(items[1]!.at).getTime(),
      );
    });

    it('свежая копия сравнивается с текущим файлом на диске', () => {
      const items = buildHistory(backupDir, knownPaths);
      const newest = items[0]!;
      // Копия = line1\nline2, текущий файл = line1\nline2\nline3 → добавлена line3.
      expect(newest.label).toBe('current');
      expect(newest.added).toBe(1);
      expect(newest.removed).toBe(0);
    });

    it('старая копия сравнивается с предыдущей: первая известная версия без диффа', () => {
      const items = buildHistory(backupDir, knownPaths);
      const oldest = items[1]!;
      expect(oldest.label).toBe('initial');
      expect(oldest.added).toBe(0);
      expect(oldest.removed).toBe(0);
    });

    it('средняя копия сравнивается с предыдущей копией', () => {
      // Третья копия между старой и свежей — у неё есть предыдущая.
      writeFileSync(
        join(backupDir, 'settings.json.2026-07-19T09-30-00-000Z.bak'),
        'line1\nlineX\n',
      );
      const items = buildHistory(backupDir, knownPaths);
      const middle = items.find((item) => item.name.includes('09-30'))!;
      // previous = line1, this = line1\nlineX → добавлена lineX.
      expect(middle.label).toBe('previous');
      expect(middle.added).toBe(1);
      expect(middle.removed).toBe(0);
    });

    it('полный дифф свежей копии содержит строки', () => {
      const diff = buildDiff(backupDir, 'settings.json.2026-07-19T10-00-00-000Z.bak', knownPaths);
      expect(diff).toBeDefined();
      expect(diff!.skipped).toBe(false);
      expect(diff!.lines.some((line) => line.kind === 'add' && line.text === 'line3')).toBe(true);
    });
  });

  describe('безопасность', () => {
    let dir: string;
    let backupDir: string;
    let knownPaths: Record<string, string>;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-history-sec-'));
      backupDir = join(dir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), 'x\n');
      writeFileSync(join(backupDir, 'settings.json.2026-07-19T10-00-00-000Z.bak'), 'y\n');
      knownPaths = { settings: join(dir, 'settings.json') };
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('копии посторонних файлов в ленту не попадают', () => {
      writeFileSync(join(backupDir, 'посторонний.json.2026-07-19T11-00-00-000Z.bak'), 'чужое');
      const items = buildHistory(backupDir, knownPaths);
      expect(items.every((item) => item.file === 'settings.json')).toBe(true);
    });

    it('обход пути в имени копии отклоняется', () => {
      expect(buildDiff(backupDir, '../../settings.json', knownPaths)).toBeUndefined();
    });

    it('дифф копии постороннего файла недоступен', () => {
      writeFileSync(join(backupDir, 'посторонний.json.2026-07-19T11-00-00-000Z.bak'), 'чужое');
      expect(
        buildDiff(backupDir, 'посторонний.json.2026-07-19T11-00-00-000Z.bak', knownPaths),
      ).toBeUndefined();
    });

    it('нет каталога копий — пустая лента без исключения', () => {
      expect(buildHistory(join(dir, 'нет-такого'), knownPaths)).toEqual([]);
    });
  });
});
