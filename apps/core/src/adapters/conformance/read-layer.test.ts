import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createClaudeAdapter } from '../claude/claude.ts';
import { createQwenAdapter } from '../qwen/qwen.ts';

/**
 * Слой чтения CLI вне копии (F-87) — факт переходника через `CliAdapter.readLayer`: каталоги
 * слоя и учётные файлы с окружением задачи, а не с домом процесса ядра.
 */

const HOME = join('/', 'h', 'user');

describe('adapter read layer — F-87 the CLI layer the judge opens and closes', () => {
  it('claude: layer dirs under the config dir; the login token, settings and the global config are credentials', () => {
    const adapter = createClaudeAdapter();
    const config = join(HOME, '.claude');
    expect(adapter.readLayer({ HOME, USERPROFILE: HOME })).toEqual({
      dirs: ['skills', 'rules', 'agents', 'commands', 'plugins'].map((d) => join(config, d)),
      credentials: [
        join(config, '.credentials.json'),
        join(config, 'settings.json'),
        join(HOME, '.claude.json'),
        join(config, '.config.json'),
      ],
      volatile: [
        join(HOME, '.claude.json'),
        join(config, '.credentials.json'),
        join(config, 'plugins'),
      ],
    });
    const moved = join('/', 'cfg');
    const layer = adapter.readLayer({ HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: moved });
    expect(layer.dirs[0]).toBe(join(moved, 'skills'));
    expect(layer.credentials).toContain(join(moved, '.credentials.json'));
    expect(layer.credentials).toContain(join(moved, '.claude.json'));
  });

  it('qwen: layer dirs under ~/.qwen or QWEN_HOME (~ expanded); OAuth files, .env and settings are credentials', () => {
    const adapter = createQwenAdapter();
    const home = join(HOME, '.qwen');
    expect(adapter.readLayer({ HOME, USERPROFILE: HOME })).toEqual({
      dirs: ['skills', 'agents', 'commands', 'rules', 'extensions'].map((d) => join(home, d)),
      credentials: [
        'oauth_creds.json',
        'mcp-oauth-tokens.json',
        'google_accounts.json',
        '.env',
        'settings.json',
      ].map((f) => join(home, f)),
      volatile: ['oauth_creds.json', 'mcp-oauth-tokens.json'].map((f) => join(home, f)),
    });
    const tilde = adapter.readLayer({ HOME, USERPROFILE: HOME, QWEN_HOME: '~/q' });
    expect(tilde.credentials[0]).toBe(join(HOME, 'q', 'oauth_creds.json'));
    // Относительный дом не достраивается: сборщик области закроет по нему судью (fail-closed).
    const relative = adapter.readLayer({ HOME, USERPROFILE: HOME, QWEN_HOME: 'rel' });
    expect(relative.credentials[0]).toBe(join('rel', 'oauth_creds.json'));
  });
});
