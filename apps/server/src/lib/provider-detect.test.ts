import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getProvider } from '../providers/registry.ts';
import { detectProvider, detectProviders, pathExists, type DetectDeps } from './provider-detect.ts';

/**
 * Детект установленных провайдер-CLI (Ф7).
 *
 * Тест НЕ зависит от реальной машины: `where`/`which` подменяются (`detectCli`),
 * существование путей — тоже (`exists`). Так сценарий «claude установлен + есть
 * конфиг, gemini только конфиг, codex ничего» воспроизводится детерминированно на
 * любой ОС. Реальная ФС трогается лишь в проверке `pathExists` (tmp-каталог).
 */

const claude = getProvider('claude');
const codex = getProvider('codex');
const gemini = getProvider('gemini');
const cursor = getProvider('cursor');

function fakeStore(provider: string, claudeDirOverride = '') {
  return { getSettings: () => ({ provider, claudeDirOverride }) };
}

/**
 * Мок сценария из задачи: claude — бинарь И конфиг; gemini — только конфиг;
 * codex — ничего. Пути распознаём по подстроке, чтобы не завязываться на homedir.
 */
const scenario: DetectDeps = {
  detectCli: (command) => command.startsWith('claude'),
  exists: (path) => path.includes('.claude') || path.includes('.gemini'),
};

describe('detectProvider: cliInstalled и configPresent по отдельности', () => {
  it('claude установлен и конфиг найден', () => {
    const result = detectProvider(claude, undefined, scenario);
    expect(result.id).toBe('claude');
    expect(result.cliInstalled).toBe(true);
    expect(result.configPresent).toBe(true);
  });

  it('gemini: CLI нет, но конфиг найден', () => {
    const result = detectProvider(gemini, undefined, scenario);
    expect(result.cliInstalled).toBe(false);
    expect(result.configPresent).toBe(true);
  });

  it('codex: ни CLI, ни конфига', () => {
    const result = detectProvider(codex, undefined, scenario);
    expect(result.cliInstalled).toBe(false);
    expect(result.configPresent).toBe(false);
  });

  it('отдаёт имя команды CLI и проверенные пути (для подсказки)', () => {
    const result = detectProvider(codex, undefined, scenario);
    expect(result.cliCommand).toMatch(/^codex(\.cmd)?$/);
    expect(result.configPaths.length).toBeGreaterThan(0);
    expect(result.configPaths[0]).toContain('.codex');
  });

  it('opencode: достаточно ЛЮБОГО из задокументированных путей', () => {
    const opencode = getProvider('opencode');
    const paths = detectProvider(opencode, undefined, scenario).configPaths;
    expect(paths).toHaveLength(2);

    const onlyXdg: DetectDeps = { detectCli: () => false, exists: (p) => p === paths[0] };
    const onlyHome: DetectDeps = { detectCli: () => false, exists: (p) => p === paths[1] };
    expect(detectProvider(opencode, undefined, onlyXdg).configPresent).toBe(true);
    expect(detectProvider(opencode, undefined, onlyHome).configPresent).toBe(true);
  });

  it('версия НЕ определяется: в результате нет поля version (CLI не спавнится)', () => {
    const result = detectProvider(claude, undefined, scenario);
    expect(result).not.toHaveProperty('version');
  });

  it('бросающий configLocations не роняет детект — configPresent false', () => {
    const broken = {
      ...cursor,
      configLocations: (): string[] => {
        throw new Error('битый override');
      },
    };
    const result = detectProvider(broken, undefined, scenario);
    expect(result.configPresent).toBe(false);
    expect(result.configPaths).toEqual([]);
  });
});

describe('detectProviders: все провайдеры + активный', () => {
  it('возвращает детект по каждому известному провайдеру, claude первым', () => {
    const data = detectProviders(fakeStore('claude'), scenario);
    expect(data.active).toBe('claude');
    expect(data.providers).toHaveLength(6);
    expect(data.providers[0]?.id).toBe('claude');

    const byId = new Map(data.providers.map((item) => [item.id, item]));
    expect(byId.get('claude')).toMatchObject({ cliInstalled: true, configPresent: true });
    expect(byId.get('gemini')).toMatchObject({ cliInstalled: false, configPresent: true });
    expect(byId.get('codex')).toMatchObject({ cliInstalled: false, configPresent: false });
  });

  it('активный провайдер берётся из настроек; незнакомый id → claude', () => {
    expect(detectProviders(fakeStore('gemini'), scenario).active).toBe('gemini');
    expect(detectProviders(fakeStore('нет-такого'), scenario).active).toBe('claude');
  });

  it('пустой детект (ничего не установлено) отдаёт все false, не бросает', () => {
    const nothing: DetectDeps = { detectCli: () => false, exists: () => false };
    const data = detectProviders(fakeStore('claude'), nothing);
    expect(data.providers.every((item) => !item.cliInstalled && !item.configPresent)).toBe(true);
  });
});

describe('pathExists: реальная ФС, но без чтения содержимого', () => {
  it('видит существующий каталог и файл, не видит отсутствующий путь', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-detect-'));
    try {
      const nested = join(dir, '.gemini');
      mkdirSync(nested);
      const file = join(dir, '.aider.conf.yml');
      writeFileSync(file, 'model: gpt\n', 'utf8');

      expect(pathExists(nested)).toBe(true);
      expect(pathExists(file)).toBe(true);
      expect(pathExists(join(dir, 'нет-такого'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
