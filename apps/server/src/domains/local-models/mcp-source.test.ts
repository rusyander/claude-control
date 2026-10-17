import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../lib/app-store/app-store.ts';
import { createLocalMcpSource } from './mcp-source.ts';

/**
 * Одобрение серверов проектного `.mcp.json` (ревью B1-F3). Группа разделения
 * получает серверы через `--mcp-config`, а флаг обходит одобрение Claude Code:
 * без фильтра `.mcp.json` чужой ветки запустил бы свою команду без спроса.
 * Файлы настоящие, во временном каталоге; сети нет — `list` её не трогает.
 */

describe('createLocalMcpSource: approvedOnly', () => {
  let dir: string;
  let project: string;
  let userConfig: string;
  let userSettings: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-source-'));
    project = join(dir, 'Project');
    mkdirSync(join(project, '.claude'), { recursive: true });
    userConfig = join(dir, '.claude.json');
    userSettings = join(dir, 'settings.json');
    writeFileSync(
      join(project, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          gitlab: { command: 'project-gitlab' },
          'lint-helper': { command: 'node', args: ['-e', 'evil()'] },
        },
      }),
    );
    writeFileSync(userSettings, '{}');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

  function source() {
    return createLocalMcpSource({
      userConfig: () => userConfig,
      userSettings: () => userSettings,
      store: new AppStore(join(dir, 'state.json')),
      appData: () => dir,
      envLookup: () => ({}),
      networkTimeoutMs: () => 1000,
    });
  }

  const writeUser = (projects: Record<string, unknown>): void =>
    writeFileSync(
      userConfig,
      JSON.stringify({ mcpServers: { gitlab: { command: 'user-gitlab' } }, projects }),
    );

  const commands = (entries: ReturnType<ReturnType<typeof source>['list']>) =>
    Object.fromEntries(entries.map((entry) => [entry.id, entry.config.command]));

  it('без одобрения проектные серверы не идут, личный с тем же именем остаётся', () => {
    writeUser({});
    expect(commands(source().list(project, { approvedOnly: true }))).toEqual({
      gitlab: 'user-gitlab',
    });
    // Без флага — прежнее поведение (локальный прогон человека в своём проекте).
    expect(commands(source().list(project))).toEqual({
      gitlab: 'project-gitlab',
      'lint-helper': 'node',
    });
  });

  it('одобрение из записи проекта в ~/.claude.json: прямые слэши и другой регистр пути', () => {
    const key = project.replaceAll('\\', '/');
    writeUser({
      [process.platform === 'win32' ? key.toUpperCase() : key]: {
        enabledMcpjsonServers: ['lint-helper'],
      },
    });
    expect(commands(source().list(project, { approvedOnly: true }))).toEqual({
      gitlab: 'user-gitlab',
      'lint-helper': 'node',
    });
  });

  it('enableAllProjectMcpServers в настройках проекта — все, отказ сильнее', () => {
    writeUser({});
    writeFileSync(
      join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ enableAllProjectMcpServers: true }),
    );
    writeFileSync(userSettings, JSON.stringify({ disabledMcpjsonServers: ['lint-helper'] }));
    expect(commands(source().list(project, { approvedOnly: true }))).toEqual({
      gitlab: 'project-gitlab',
    });
  });

  it('одобрение чужого проекта не переносится', () => {
    writeUser({ [join(dir, 'Other')]: { enableAllProjectMcpServers: true } });
    expect(Object.keys(commands(source().list(project, { approvedOnly: true })))).toEqual([
      'gitlab',
    ]);
  });
});
