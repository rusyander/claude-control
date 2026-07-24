import { describe, it, expect, afterEach } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getProvider } from './registry.ts';

/**
 * Ф9/Ф10 — ЗАДОКУМЕНТИРОВАННЫЕ переопределения каталогов конфигурации.
 *
 * Уважаем ровно две переменные сверх claude-овской `CLAUDE_CONFIG_DIR`:
 *   • `CODEX_HOME` — Codex целиком переносит `~/.codex`;
 *   • `XDG_CONFIG_HOME` — OpenCode лежит в `$XDG_CONFIG_HOME/opencode`
 *     (на Linux это НЕ косметика: с заданной переменной `~/.config/opencode`
 *     просто неверный путь).
 * У Gemini/Cursor/Aider задокументированного переопределения нет → путь обязан
 * оставаться от домашнего каталога, ничего не выдумываем.
 */
const ENV_KEYS = ['CODEX_HOME', 'XDG_CONFIG_HOME'] as const;
const saved = new Map<string, string | undefined>();

function setEnv(name: string, value: string | undefined): void {
  if (!saved.has(name)) saved.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  saved.clear();
});

describe('Codex: CODEX_HOME', () => {
  it('без переменной — путь от домашнего каталога', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    const codex = getProvider('codex');

    expect(codex.instructionsFile!()).toBe(join(homedir(), '.codex', 'AGENTS.md'));
    expect(codex.mcpConfig!.path()).toBe(join(homedir(), '.codex', 'config.toml'));
    expect(codex.configLocations!()).toEqual([join(homedir(), '.codex')]);
  });

  it('с переменной переносятся ВСЕ пути codex: инструкции, MCP, env, права, детект', () => {
    const moved = join(homedir(), 'codex-elsewhere');
    setEnv('CODEX_HOME', moved);
    const codex = getProvider('codex');

    expect(codex.instructionsFile!()).toBe(join(moved, 'AGENTS.md'));
    expect(codex.mcpConfig!.path()).toBe(join(moved, 'config.toml'));
    expect(codex.envConfig!.path()).toBe(join(moved, 'config.toml'));
    expect(codex.permissionsConfig!.path()).toBe(join(moved, 'config.toml'));
    expect(codex.configLocations!()).toEqual([moved]);
  });

  it('относительный путь становится абсолютным, пустая переменная игнорируется', () => {
    setEnv('CODEX_HOME', 'codex-rel');
    expect(getProvider('codex').mcpConfig!.path()).toBe(join(resolve('codex-rel'), 'config.toml'));

    setEnv('CODEX_HOME', '   ');
    expect(getProvider('codex').mcpConfig!.path()).toBe(join(homedir(), '.codex', 'config.toml'));
  });
});

describe('OpenCode: XDG_CONFIG_HOME', () => {
  it('без переменной — ~/.config/opencode (текущее поведение)', () => {
    for (const key of ENV_KEYS) setEnv(key, undefined);
    const opencode = getProvider('opencode');

    expect(opencode.mcpConfig!.path()).toBe(
      join(homedir(), '.config', 'opencode', 'opencode.json'),
    );
    expect(opencode.instructionsFile!()).toBe(join(homedir(), '.config', 'opencode', 'AGENTS.md'));
  });

  it('с переменной конфиг и инструкции берутся из $XDG_CONFIG_HOME/opencode', () => {
    const xdg = join(homedir(), 'xdg-config');
    setEnv('XDG_CONFIG_HOME', xdg);
    const opencode = getProvider('opencode');

    expect(opencode.mcpConfig!.path()).toBe(join(xdg, 'opencode', 'opencode.json'));
    expect(opencode.instructionsFile!()).toBe(join(xdg, 'opencode', 'AGENTS.md'));
    // Детект: XDG-каталог первый, запасной ~/.opencode остаётся вторым.
    expect(opencode.configLocations!()).toEqual([
      join(xdg, 'opencode'),
      join(homedir(), '.opencode'),
    ]);
  });
});

describe('провайдеры без задокументированного переопределения', () => {
  it('gemini/cursor/aider переменные окружения НЕ уважают (не угадываем)', () => {
    setEnv('XDG_CONFIG_HOME', join(homedir(), 'xdg-config'));
    setEnv('CODEX_HOME', join(homedir(), 'codex-elsewhere'));

    expect(getProvider('gemini').mcpConfig!.path()).toBe(
      join(homedir(), '.gemini', 'settings.json'),
    );
    expect(getProvider('gemini').instructionsFile!()).toBe(join(homedir(), '.gemini', 'GEMINI.md'));
    expect(getProvider('cursor').mcpConfig!.path()).toBe(join(homedir(), '.cursor', 'mcp.json'));
    expect(getProvider('aider').configLocations!()).toEqual([
      join(homedir(), '.aider.conf.yml'),
      join(homedir(), '.aider.model.settings.yml'),
    ]);
  });
});
