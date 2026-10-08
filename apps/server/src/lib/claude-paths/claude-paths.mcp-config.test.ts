import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Где панель ищет `.claude.json` — регистрацию MCP-серверов, запись аккаунта,
 * доверие и историю проектов.
 *
 * Правило не наше, а CLI, и оно РАЗНОЕ (живая проверка 18.09.2026, claude
 * 2.1.263, `.agent/tmp/live-checks/mcp-config-dir-probe.mjs` и
 * `mcp-config-dir-fallback.mjs`): при заданном `CLAUDE_CONFIG_DIR` файл лежит
 * ВНУТРИ каталога, и домашний CLI не читает даже когда внутреннего файла нет;
 * без переменной — рядом с `~/.claude`.
 *
 * Пока панель всегда брала соседний файл, сервер, заведённый в панели на стенде
 * со своим каталогом, до агента не доезжал: CLI отвечал «инструмент недоступен»,
 * а карточка аккаунта стояла пустой при живом входе.
 *
 * Домашнюю ветку иначе не проверить: `homedir()` подменяется на временный
 * каталог, всё остальное — настоящее.
 */
const fake = vi.hoisted(() => ({ home: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fake.home };
});

const { detectClaudeLocation } = await import('./claude-paths.ts');

describe('claude-paths: спутник .claude.json', () => {
  let dir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-mcpcfg-'));
    fake.home = join(dir, 'home');
    mkdirSync(join(fake.home, '.claude'), { recursive: true });
    originalEnv = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = originalEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  it('домашний каталог без переменной: файл РЯДОМ с ~/.claude', () => {
    const loc = detectClaudeLocation();
    expect(loc.source).toBe('home');
    expect(loc.paths.mcpConfig).toBe(join(fake.home, '.claude.json'));
  });

  it('каталог из CLAUDE_CONFIG_DIR: файл ВНУТРИ каталога', () => {
    const envDir = join(dir, 'env-config');
    mkdirSync(envDir);
    process.env.CLAUDE_CONFIG_DIR = envDir;
    const loc = detectClaudeLocation();
    expect(loc.source).toBe('env');
    expect(loc.paths.mcpConfig).toBe(join(resolve(envDir), '.claude.json'));
  });

  it('домашний каталог, названный переменной явно: файл ВНУТРИ — как у CLI', () => {
    // Крайний случай, на котором ломается догадка «домашний путь ⇒ сосед»:
    // переменная задана, значит CLI берёт `~/.claude/.claude.json`.
    const home = join(fake.home, '.claude');
    process.env.CLAUDE_CONFIG_DIR = home;
    const loc = detectClaudeLocation();
    expect(loc.source).toBe('env');
    expect(loc.paths.mcpConfig).toBe(join(home, '.claude.json'));
  });

  it('каталог, указанный в настройках: файл ВНУТРИ него', () => {
    const manual = join(dir, 'manual-config');
    mkdirSync(manual);
    const loc = detectClaudeLocation(manual);
    expect(loc.source).toBe('manual');
    expect(loc.paths.mcpConfig).toBe(join(resolve(manual), '.claude.json'));
  });

  it('несуществующий каталог из настроек: правило то же, путь предсказуем', () => {
    // Пути строятся и для невалидного каталога — интерфейс показывает их
    // человеку в объяснении проблемы.
    const missing = join(dir, 'нет-такого');
    const loc = detectClaudeLocation(missing);
    expect(loc.isValid).toBe(false);
    expect(loc.paths.mcpConfig).toBe(join(resolve(missing), '.claude.json'));
  });
});
