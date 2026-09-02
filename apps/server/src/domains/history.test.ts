import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { diffLines, buildHistory, buildDiff, revertHunk } from './history.ts';
import type { TrackedFile } from './tracked-files.ts';

/**
 * История изменений — лента правок из резервных копий с построчным диффом.
 *
 * Проверяем три вещи: чистый LCS-дифф (добавление/удаление/без изменений и
 * счётчики), сборку ленты из копий во времени (кто с чем сравнивается) и
 * безопасность — имя копии приходит из запроса, `../` не должен читать чужой
 * файл, а посторонние файлы в каталоге копий в ленту не попадают.
 */

/** Отслеживаемый файл Claude: имя копии = basename, откат разрешён. */
function claudeTarget(path: string): TrackedFile {
  const file = basename(path);
  return { backupBase: file, path, file, canRevert: true };
}

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
    let knownPaths: TrackedFile[];

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

      knownPaths = [claudeTarget(settingsPath)];
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
    let knownPaths: TrackedFile[];

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-history-sec-'));
      backupDir = join(dir, 'backups');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), 'x\n');
      writeFileSync(join(backupDir, 'settings.json.2026-07-19T10-00-00-000Z.bak'), 'y\n');
      knownPaths = [claudeTarget(join(dir, 'settings.json'))];
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

  describe('файлы провайдера в ленте (Ф11a)', () => {
    let dir: string;
    let backupDir: string;
    let claudeSettings: string;
    let geminiSettings: string;
    let targets: TrackedFile[];
    const GEMINI_COPY = 'gemini-settings.json.2026-07-20T10-00-00-000Z.bak';
    const CLAUDE_COPY = 'settings.json.2026-07-20T10-00-00-000Z.bak';

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-history-prov-'));
      backupDir = join(dir, 'backups');
      mkdirSync(backupDir, { recursive: true });

      // Одинаковый basename у обоих файлов — ровно тот случай, ради которого
      // копии провайдеров получили префикс `<id>-` (Ф9-10).
      claudeSettings = join(dir, 'claude', 'settings.json');
      geminiSettings = join(dir, 'gemini', 'settings.json');
      mkdirSync(join(dir, 'claude'));
      mkdirSync(join(dir, 'gemini'));
      writeFileSync(claudeSettings, 'claude-1\nclaude-2\n');
      writeFileSync(geminiSettings, 'gemini-1\ngemini-2\n');
      writeFileSync(join(backupDir, CLAUDE_COPY), 'claude-1\n');
      writeFileSync(join(backupDir, GEMINI_COPY), 'gemini-1\n');

      targets = [
        claudeTarget(claudeSettings),
        {
          backupBase: 'gemini-settings.json',
          path: geminiSettings,
          file: 'settings.json',
          canRevert: false,
          providerId: 'gemini',
          providerName: 'Gemini CLI',
        },
      ];
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('правка файла провайдера видна в ленте с его пометкой', () => {
      const items = buildHistory(backupDir, targets);
      const gemini = items.find((item) => item.name === GEMINI_COPY)!;
      expect(gemini.providerId).toBe('gemini');
      expect(gemini.providerName).toBe('Gemini CLI');
      // Показываем basename файла, а не имя копии с префиксом.
      expect(gemini.file).toBe('settings.json');
      expect(gemini.canRevert).toBe(false);
    });

    it('дифф копии провайдера считается против ЕГО файла, а не файла Claude', () => {
      const diff = buildDiff(backupDir, GEMINI_COPY, targets)!;
      expect(diff.label).toBe('current');
      // Копия = gemini-1, текущий gemini-файл = gemini-1 + gemini-2.
      expect(diff.lines.some((line) => line.kind === 'add' && line.text === 'gemini-2')).toBe(true);
      // Ни одной строки из конфигурации Claude в дифф не попало.
      expect(diff.lines.some((line) => line.text.startsWith('claude-'))).toBe(false);
      expect(diff.canRevert).toBe(false);
      expect(diff.providerId).toBe('gemini');
    });

    it('файл Claude в той же ленте сравнивается со своим файлом и откатываем', () => {
      const claude = buildDiff(backupDir, CLAUDE_COPY, targets)!;
      expect(claude.lines.some((line) => line.kind === 'add' && line.text === 'claude-2')).toBe(
        true,
      );
      expect(claude.canRevert).toBe(true);
      expect(claude.providerId).toBeUndefined();
    });

    it('ОТКАТ копии провайдера отклоняется — конфигурация Claude не тронута', () => {
      const result = revertHunk(backupDir, GEMINI_COPY, 0, targets, backupDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/только для просмотра/i);
      expect(readFileSync(claudeSettings, 'utf8')).toBe('claude-1\nclaude-2\n');
      expect(readFileSync(geminiSettings, 'utf8')).toBe('gemini-1\ngemini-2\n');
    });

    it('провайдер не активен — его копий в ленте нет вовсе', () => {
      const items = buildHistory(backupDir, [claudeTarget(claudeSettings)]);
      expect(items.map((item) => item.name)).toEqual([CLAUDE_COPY]);
    });
  });

  describe('копии проектов и пропущенные диффы', () => {
    let dir: string;
    let backupDir: string;
    let settingsPath: string;
    const USER_COPY = 'settings.json.2026-07-19T10-00-00-000Z.bak';
    // Копия `<проект>/.claude/settings.json` — под именем проекта (`projectBackupName`).
    const PROJECT_COPY = 'project-0f1e2d3c-settings.json.2026-07-19T11-00-00-000Z.bak';

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cc-history-project-'));
      backupDir = join(dir, 'backups');
      settingsPath = join(dir, 'settings.json');
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(settingsPath, 'user-1\nuser-2\n');
      writeFileSync(join(backupDir, USER_COPY), 'user-1\n');
      writeFileSync(join(backupDir, PROJECT_COPY), '{ "permissions": {} }\n');
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('копия проектного файла в ленту пользовательского уровня не попадает и не диффится', () => {
      const targets = [claudeTarget(settingsPath)];
      expect(buildHistory(backupDir, targets).map((item) => item.name)).toEqual([USER_COPY]);
      expect(buildDiff(backupDir, PROJECT_COPY, targets)).toBeUndefined();
      const revert = revertHunk(backupDir, PROJECT_COPY, 0, targets, backupDir);
      expect(revert.ok).toBe(false);
      expect(revert.notFound).toBe(true);
      expect(readFileSync(settingsPath, 'utf8')).toBe('user-1\nuser-2\n');
    });

    it('бинарная копия едет в ленту с причиной пропуска, а не как «без изменений»', () => {
      writeFileSync(join(backupDir, USER_COPY), Buffer.from([0x75, 0x00, 0x01, 0x02]));
      const [entry] = buildHistory(backupDir, [claudeTarget(settingsPath)]);
      expect(entry?.added).toBe(0);
      expect(entry?.removed).toBe(0);
      expect(entry?.skipped).toBe(true);
      expect(entry?.reason).toBe('binary');
    });
  });
});
