import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ClaudeLocation } from '@claude-control/contracts';
import {
  listResourceFiles,
  readResourceFile,
  writeResourceFile,
  deleteResourceFile,
  moveResourceFile,
} from './ResourceFiles.ts';

/**
 * Тесты работы с файлами ресурсов. Отдельный упор — на безопасность: аудит
 * находил здесь два критичных бага (удаление всей папки пустым `file`,
 * схлопывание id в корень), поэтому каждый закрыт регрессионным тестом,
 * чтобы не вернулся.
 *
 * Каждый тест поднимает свой временный каталог, играющий роль ~/.claude,
 * и убирает его за собой — настоящая конфигурация не затрагивается.
 */
describe('ResourceFiles', () => {
  let root: string;
  let location: ClaudeLocation;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cc-resfiles-'));
    mkdirSync(join(root, 'skills'), { recursive: true });
    mkdirSync(join(root, 'hooks'), { recursive: true });

    // Скилл с вложенной структурой — на нём проверяем дерево и правки.
    mkdirSync(join(root, 'skills', 'demo', 'references'), { recursive: true });
    writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), '# demo');
    writeFileSync(join(root, 'skills', 'demo', 'references', 'rules.md'), 'rules');
    writeFileSync(join(root, 'hooks', 'guard.mjs'), 'script');

    // Минимальный ClaudeLocation: тестам нужны только пути.
    location = {
      source: 'manual',
      paths: {
        root,
        settings: join(root, 'settings.json'),
        settingsLocal: join(root, 'settings.local.json'),
        claudeMd: join(root, 'CLAUDE.md'),
        secretsEnv: join(root, '.mcp-secrets.env'),
        skills: join(root, 'skills'),
        hooks: join(root, 'hooks'),
        mcpConfig: join(root, '.claude.json'),
        appData: join(root, 'claude-control'),
      },
      isValid: true,
      missing: [],
    } as ClaudeLocation;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('чтение дерева', () => {
    it('перечисляет вложенные файлы скилла относительными путями', () => {
      const files = listResourceFiles('skill', 'demo', location).map((f) => f.path);
      expect(files).toContain('SKILL.md');
      expect(files).toContain('references/rules.md');
    });

    it('одиночный файл (скрипт) — это он сам', () => {
      const files = listResourceFiles('script', 'guard.mjs', location);
      expect(files).toHaveLength(1);
      expect(files[0]?.path).toBe('guard.mjs');
    });
  });

  describe('правка и создание', () => {
    it('пишет новый вложенный файл, создавая папку', () => {
      writeResourceFile('skill', 'demo', 'config/eslint.json', '{}', location);
      expect(existsSync(join(root, 'skills', 'demo', 'config', 'eslint.json'))).toBe(true);
    });

    it('читает записанное содержимое', () => {
      writeResourceFile('skill', 'demo', 'note.md', 'hello', location);
      expect(readResourceFile('skill', 'demo', 'note.md', location).content).toBe('hello');
    });

    it('плагины доступны только на чтение', () => {
      expect(() => writeResourceFile('plugin', 'x', 'a.txt', 'x', location)).toThrow();
    });
  });

  // ── Регрессия критичных багов из аудита безопасности ──
  describe('безопасность', () => {
    it('пустой file не удаляет всю папку ресурса', () => {
      deleteResourceFile('skill', 'demo', '', location);
      // Папка и её содержимое на месте — операция над корнем отклонена.
      expect(existsSync(join(root, 'skills', 'demo', 'SKILL.md'))).toBe(true);
    });

    it('file="." не удаляет папку ресурса', () => {
      deleteResourceFile('skill', 'demo', '.', location);
      expect(existsSync(join(root, 'skills', 'demo', 'SKILL.md'))).toBe(true);
    });

    it('id из кириллицы не даёт доступ к корню skills/', () => {
      // safeSegment схлопнул бы «скилл» в пустоту → корнем стала бы вся папка.
      const files = listResourceFiles('skill', 'скилл', location);
      expect(files).toHaveLength(0);
    });

    it('запись по небезопасному id отклоняется, файл в корне не создаётся', () => {
      expect(() => writeResourceFile('skill', '🎉', 'evil.txt', 'x', location)).toThrow();
      expect(existsSync(join(root, 'skills', 'evil.txt'))).toBe(false);
    });

    it('обход пути ../ за пределы ресурса отклоняется', () => {
      expect(() => writeResourceFile('skill', 'demo', '../../evil.txt', 'x', location)).toThrow();
      expect(existsSync(join(root, 'evil.txt'))).toBe(false);
    });

    it('move не затирает существующий целевой файл', () => {
      writeResourceFile('skill', 'demo', 'a.txt', 'AAA', location);
      writeResourceFile('skill', 'demo', 'b.txt', 'BBB', location);
      expect(() => moveResourceFile('skill', 'demo', 'a.txt', 'b.txt', location)).toThrow();
      // b.txt сохранил своё содержимое.
      expect(readFileSync(join(root, 'skills', 'demo', 'b.txt'), 'utf8')).toBe('BBB');
    });

    it('удаление конкретного файла работает штатно', () => {
      writeResourceFile('skill', 'demo', 'temp.txt', 'x', location);
      deleteResourceFile('skill', 'demo', 'temp.txt', location);
      expect(existsSync(join(root, 'skills', 'demo', 'temp.txt'))).toBe(false);
    });
  });

  /**
   * Это единственный путь, которым интерфейс удаляет файлы внутри скилла, —
   * значит и копия должна делаться здесь. Раньше её не было вовсе: копия
   * лежала в параллельной реализации на легаси-маршрутах, куда интерфейс не
   * ходил, а сами маршруты с тех пор убраны.
   */
  describe('резервная копия при удалении', () => {
    const backupDir = (): string => join(root, 'claude-control', 'backups');

    it('файл копируется перед удалением', () => {
      writeResourceFile('skill', 'demo', 'заметки.md', 'текст заметки', location);

      const backupPath = deleteResourceFile('skill', 'demo', 'заметки.md', location, backupDir());

      expect(existsSync(join(root, 'skills', 'demo', 'заметки.md'))).toBe(false);
      expect(readFileSync(backupPath!, 'utf8')).toBe('текст заметки');
    });

    it('папка внутри скилла копируется целиком', () => {
      const backupPath = deleteResourceFile('skill', 'demo', 'references', location, backupDir());

      expect(existsSync(join(root, 'skills', 'demo', 'references'))).toBe(false);
      expect(readFileSync(join(backupPath!, 'rules.md'), 'utf8')).toBe('rules');
    });

    it('без каталога копий удаляет как раньше', () => {
      writeResourceFile('skill', 'demo', 'temp.txt', 'x', location);

      expect(deleteResourceFile('skill', 'demo', 'temp.txt', location)).toBeUndefined();
      expect(existsSync(join(root, 'skills', 'demo', 'temp.txt'))).toBe(false);
    });

    it('удаление несуществующего файла копию не создаёт', () => {
      expect(
        deleteResourceFile('skill', 'demo', 'нет-такого.md', location, backupDir()),
      ).toBeUndefined();
      expect(existsSync(backupDir())).toBe(false);
    });
  });
});
