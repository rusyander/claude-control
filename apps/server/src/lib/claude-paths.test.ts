import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { detectClaudeLocation } from './claude-paths.ts';

/**
 * Тесты определения каталога конфигурации Claude Code. Порядок приоритетов
 * (override → CLAUDE_CONFIG_DIR → ~/.claude) закреплён тестами, потому что от
 * него зависит, чей конфиг увидит и будет править приложение.
 *
 * Ветку ~/.claude намеренно не трогаем — все кейсы управляются явным override
 * и контролируемой переменной окружения, указывающими на временные каталоги,
 * чтобы результат не зависел от реального окружения машины. Исходное значение
 * CLAUDE_CONFIG_DIR сохраняется и восстанавливается.
 */
describe('detectClaudeLocation', () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-paths-'));
    // Гасим внешнюю CLAUDE_CONFIG_DIR, чтобы кейсы с override/home были
    // детерминированы независимо от машины.
    originalEnv = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  describe('override пользователя', () => {
    it('существующий override принимается: source=manual, isValid', () => {
      const loc = detectClaudeLocation(dir);
      expect(loc.source).toBe('manual');
      expect(loc.isValid).toBe(true);
      expect(loc.paths.root).toBe(resolve(dir));
    });

    it('несуществующий override: manual, невалиден, с объяснением проблемы', () => {
      // Путь, заданный руками, разбираем подробно — пользователь ждёт причину.
      const missingPath = join(dir, 'нет-каталога');
      const loc = detectClaudeLocation(missingPath);
      expect(loc.source).toBe('manual');
      expect(loc.isValid).toBe(false);
      expect(loc.problem).toContain('не существует');
      expect(loc.missing).toEqual([]);
      expect(loc.paths.root).toBe(resolve(missingPath));
    });

    it('пробельный override игнорируется — берётся следующий кандидат', () => {
      // '   ' не считается заданным путём; управление уходит к CLAUDE_CONFIG_DIR.
      const envDir = join(dir, 'env-config');
      mkdirSync(envDir);
      process.env.CLAUDE_CONFIG_DIR = envDir;
      const loc = detectClaudeLocation('   ');
      expect(loc.source).toBe('env');
      expect(loc.paths.root).toBe(resolve(envDir));
    });
  });

  describe('приоритеты источников', () => {
    it('CLAUDE_CONFIG_DIR используется, когда override не задан', () => {
      const envDir = join(dir, 'env-config');
      mkdirSync(envDir);
      process.env.CLAUDE_CONFIG_DIR = envDir;
      const loc = detectClaudeLocation();
      expect(loc.source).toBe('env');
      expect(loc.isValid).toBe(true);
      expect(loc.paths.root).toBe(resolve(envDir));
    });

    it('override перекрывает CLAUDE_CONFIG_DIR', () => {
      // Оба валидны — побеждает явный override (первый кандидат в списке).
      const envDir = join(dir, 'env-config');
      const overrideDir = join(dir, 'override-config');
      mkdirSync(envDir);
      mkdirSync(overrideDir);
      process.env.CLAUDE_CONFIG_DIR = envDir;
      const loc = detectClaudeLocation(overrideDir);
      expect(loc.source).toBe('manual');
      expect(loc.paths.root).toBe(resolve(overrideDir));
    });
  });

  describe('построение путей', () => {
    it('все пути строятся от корня, а .claude.json лежит рядом с каталогом', () => {
      const loc = detectClaudeLocation(dir);
      const root = loc.paths.root;
      expect(loc.paths.settings).toBe(join(root, 'settings.json'));
      expect(loc.paths.settingsLocal).toBe(join(root, 'settings.local.json'));
      expect(loc.paths.claudeMd).toBe(join(root, 'CLAUDE.md'));
      expect(loc.paths.secretsEnv).toBe(join(root, '.mcp-secrets.env'));
      expect(loc.paths.skills).toBe(join(root, 'skills'));
      expect(loc.paths.hooks).toBe(join(root, 'hooks'));
      expect(loc.paths.appData).toBe(join(root, 'claude-control'));
      // Регистрация MCP-серверов — НЕ внутри .claude, а рядом.
      expect(loc.paths.mcpConfig).toBe(join(dirname(root), '.claude.json'));
    });
  });

  describe('список отсутствующих файлов', () => {
    it('перечисляет ожидаемые, но отсутствующие файлы', () => {
      // Каталог валиден, но заполнен частично — missing показывает, чего нет.
      writeFileSync(join(dir, 'settings.json'), '{}');
      mkdirSync(join(dir, 'skills'));
      const loc = detectClaudeLocation(dir);
      expect(loc.isValid).toBe(true);
      expect(loc.missing).toContain('CLAUDE.md');
      expect(loc.missing).toContain('hooks/');
      expect(loc.missing).toContain('.claude.json');
      expect(loc.missing).not.toContain('settings.json');
      expect(loc.missing).not.toContain('skills/');
    });

    it('когда все ожидаемые файлы на месте, missing пуст', () => {
      // root вложен в dir, чтобы контролировать соседний .claude.json.
      const root = join(dir, '.claude');
      mkdirSync(root);
      writeFileSync(join(root, 'settings.json'), '{}');
      writeFileSync(join(root, 'CLAUDE.md'), '# правила');
      mkdirSync(join(root, 'skills'));
      mkdirSync(join(root, 'hooks'));
      writeFileSync(join(dir, '.claude.json'), '{}'); // сосед каталога .claude
      const loc = detectClaudeLocation(root);
      expect(loc.isValid).toBe(true);
      expect(loc.missing).toEqual([]);
    });
  });
});
