import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Чтение входа из связки ключей на «маке»: подменены платформа и граница с ОС —
 * вызов `security` (машины с macOS нет); выбор имени записи и разбор ответа —
 * настоящие. Домашний каталог временный: файл панели пользователя не читается.
 */
const security = vi.fn<(file: string, args: readonly string[]) => string>();
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  execFileSync: (file: string, args: readonly string[]) => security(file, args),
}));

const LOGIN = '{"claudeAiOauth":{"accessToken":"из-связки"}}';
let home = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'keychain-home-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.stubEnv('CLAUDE_SECURESTORAGE_CONFIG_DIR', undefined);
  vi.stubGlobal('process', { ...process, platform: 'darwin' });
  security.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('readClaudeCredentials на macOS', () => {
  it('нестандартный каталог — вход берётся из записи с хешем каталога', async () => {
    // Каталога нет на диске — и не нужно: файла входа там нет, ищется связка.
    const root = '/Users/me/claude-work';
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    const { readClaudeCredentials } = await import('./credentials.ts');
    // Литерал, а не вызов тестируемой функции: иначе тест сверял бы её с самой собой.
    const own = 'Claude Code-credentials-cbe7f9b7';
    security.mockImplementation((_file, args) => {
      if (args.includes(own)) return `${LOGIN}\n`;
      throw new Error('The specified item could not be found in the keychain.');
    });

    const result = readClaudeCredentials(root);

    expect(result).toMatchObject({ source: 'keychain', content: LOGIN });
    expect(security.mock.calls[0]).toEqual([
      'security',
      ['find-generic-password', '-s', own, '-w'],
    ]);
  });

  it('записи с хешем нет — запасом прежнее имя, как было до правки', async () => {
    const root = join(home, 'claude-work');
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    const { readClaudeCredentials } = await import('./credentials.ts');
    security.mockImplementation((_file, args) => {
      if (args.includes('Claude Code-credentials')) return LOGIN;
      throw new Error('not found');
    });

    expect(readClaudeCredentials(root)).toMatchObject({ source: 'keychain', content: LOGIN });
  });
});
