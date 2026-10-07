import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectClaudeLocation, standaloneAppDataDir } from './claude-paths.ts';

/**
 * Машина без `~/.claude` (выбран другой CLI). Домашний каталог подменяется
 * через HOME/USERPROFILE — `os.homedir()` читает их, — поэтому реальный
 * `~/.claude` машины в кейсах не участвует.
 */
describe('detectClaudeLocation без каталога Claude', () => {
  let home: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cc-standalone-'));
    for (const key of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR']) saved[key] = process.env[key];
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it('данные панели — в ~/.agentdeck/data, а ~/.claude не появляется', () => {
    const location = detectClaudeLocation();
    expect(location.source).toBe('not-found');
    expect(location.isValid).toBe(false);
    expect(location.paths.appData).toBe(join(home, '.agentdeck', 'data'));
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('существующий ~/.claude: данные панели остаются внутри него (identity)', () => {
    mkdirSync(join(home, '.claude'));
    const location = detectClaudeLocation();
    expect(location.source).toBe('home');
    expect(location.paths.appData).toBe(join(home, '.claude', 'agentdeck'));
  });

  it('панель жила без Claude, потом появился ~/.claude — настройки не теряются', () => {
    const standalone = standaloneAppDataDir(home);
    mkdirSync(standalone, { recursive: true });
    writeFileSync(join(standalone, 'state.json'), '{}');
    mkdirSync(join(home, '.claude'));
    expect(detectClaudeLocation().paths.appData).toBe(standalone);
  });

  it('свой каталог данных в ~/.claude главнее отдельного', () => {
    const standalone = standaloneAppDataDir(home);
    mkdirSync(standalone, { recursive: true });
    writeFileSync(join(standalone, 'state.json'), '{}');
    mkdirSync(join(home, '.claude', 'agentdeck'), { recursive: true });
    expect(detectClaudeLocation().paths.appData).toBe(join(home, '.claude', 'agentdeck'));
  });
});
