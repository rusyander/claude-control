import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBackups, restoreBackup, deleteBackup } from './backups.ts';

/**
 * Откат к резервной копии. Раньше копии были доступны только через проводник:
 * страховка есть, а воспользоваться ею из панели нельзя.
 *
 * Два места, где легко ошибиться, и оба закреплены тестами: имя копии приходит
 * из запроса (значит `../` не должен уводить запись за пределы конфигурации) и
 * сам откат обязан быть обратимым — иначе он опаснее того, от чего спасает.
 */
describe('Резервные копии', () => {
  let dir: string;
  let backupDir: string;
  let settingsPath: string;
  let knownPaths: Record<string, string>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-backups-'));
    backupDir = join(dir, 'backups');
    settingsPath = join(dir, 'settings.json');
    mkdirSync(backupDir, { recursive: true });

    writeFileSync(settingsPath, '{"version":"новая"}');
    writeFileSync(
      join(backupDir, 'settings.json.2026-07-19T10-00-00-000Z.bak'),
      '{"version":"старая"}',
    );
    writeFileSync(join(backupDir, 'CLAUDE.md.2026-07-19T09-00-00-000Z.bak'), '# правила');

    knownPaths = { settings: settingsPath, claudeMd: join(dir, 'CLAUDE.md') };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('список', () => {
    it('разбирает имя копии на файл и время', () => {
      const items = listBackups(backupDir);
      const settings = items.find((item) => item.target === 'settings.json');

      expect(settings).toBeDefined();
      expect(settings?.sizeBytes).toBeGreaterThan(0);
    });

    it('свежие идут первыми', () => {
      const items = listBackups(backupDir);
      expect(items).toHaveLength(2);
      expect(new Date(items[0]!.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(items[1]!.createdAt).getTime(),
      );
    });

    it('посторонние файлы в каталоге пропускаются', () => {
      writeFileSync(join(backupDir, 'заметка.txt'), 'не копия');
      expect(listBackups(backupDir)).toHaveLength(2);
    });

    it('нет каталога — пустой список, без исключения', () => {
      expect(listBackups(join(dir, 'нет-такого'))).toEqual([]);
    });

    /**
     * В каталоге копий лежат не только файлы конфигурации: удаление скилла
     * кладёт туда целую папку. Предлагать для неё кнопку отката — обман:
     * восстановление копирует файл и папку вернуть не может.
     */
    describe('что можно вернуть кнопкой', () => {
      it('копия известного файла конфигурации — можно', () => {
        const settings = listBackups(backupDir, knownPaths).find(
          (item) => item.target === 'settings.json',
        );

        expect(settings?.canRestore).toBe(true);
      });

      it('копия папки скилла — нельзя', () => {
        mkdirSync(join(backupDir, 'skills-мой-скилл.2026-07-19T12-00-00-000Z.bak'), {
          recursive: true,
        });

        const folder = listBackups(backupDir, knownPaths).find((item) =>
          item.name.startsWith('skills-мой-скилл'),
        );

        expect(folder).toBeDefined();
        expect(folder?.canRestore).toBe(false);
      });

      it('копия постороннего файла — нельзя: цель неизвестна', () => {
        writeFileSync(join(backupDir, 'посторонний.json.2026-07-19T11-00-00-000Z.bak'), 'чужое');

        const stranger = listBackups(backupDir, knownPaths).find((item) =>
          item.name.startsWith('посторонний'),
        );

        expect(stranger?.canRestore).toBe(false);
      });
    });
  });

  describe('откат', () => {
    const NAME = 'settings.json.2026-07-19T10-00-00-000Z.bak';

    it('возвращает содержимое копии в файл', () => {
      const result = restoreBackup(backupDir, NAME, knownPaths);

      expect(result.ok).toBe(true);
      expect(readFileSync(settingsPath, 'utf8')).toBe('{"version":"старая"}');
    });

    it('ГЛАВНОЕ: сам откат обратим — состояние до него сохраняется копией', () => {
      const result = restoreBackup(backupDir, NAME, knownPaths);

      expect(result.backupPath).toBeDefined();
      expect(readFileSync(result.backupPath!, 'utf8')).toBe('{"version":"новая"}');
    });

    it('неизвестная копия отклоняется', () => {
      const result = restoreBackup(backupDir, 'нет-такой.bak', knownPaths);

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/не найдена/);
    });

    it('копия файла, которого нет в списке разрешённых, не восстанавливается', () => {
      writeFileSync(join(backupDir, 'посторонний.json.2026-07-19T11-00-00-000Z.bak'), 'чужое');

      const result = restoreBackup(
        backupDir,
        'посторонний.json.2026-07-19T11-00-00-000Z.bak',
        knownPaths,
      );

      expect(result.ok).toBe(false);
      expect(existsSync(join(dir, 'посторонний.json'))).toBe(false);
    });

    it('обход пути в имени копии никуда не пишет', () => {
      // Имя приходит из запроса: `../` не должен уводить запись за пределы.
      const result = restoreBackup(backupDir, '../../evil.json', knownPaths);

      expect(result.ok).toBe(false);
      expect(existsSync(join(dir, '..', 'evil.json'))).toBe(false);
    });

    it('восстановление в файл, которого ещё нет, работает', () => {
      const result = restoreBackup(backupDir, 'CLAUDE.md.2026-07-19T09-00-00-000Z.bak', knownPaths);

      expect(result.ok).toBe(true);
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('# правила');
      // Заменять было нечего — и копии «состояния до» тоже нет.
      expect(result.backupPath).toBeUndefined();
    });
  });

  describe('удаление копии', () => {
    it('удаляет названную копию', () => {
      expect(deleteBackup(backupDir, 'CLAUDE.md.2026-07-19T09-00-00-000Z.bak')).toBe(true);
      expect(listBackups(backupDir)).toHaveLength(1);
    });

    it('неизвестное имя — отказ, ничего не удалено', () => {
      expect(deleteBackup(backupDir, '../settings.json')).toBe(false);
      expect(existsSync(settingsPath)).toBe(true);
    });
  });
});
