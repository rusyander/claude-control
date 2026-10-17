import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * MCP-серверы, взятые человеком в локальный прогон (L4): запись едет отдельным
 * `--mcp-config` рядом с `--strict-mcp-config` слоя. Подменён только `spawn` —
 * аргументы и файл читаются такими, какими их получил бы CLI.
 */

class FakeChild extends EventEmitter {
  readonly stdin = Object.assign(new EventEmitter(), {
    write: (): boolean => true,
    end: () => undefined,
  });
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

interface Seen {
  args: string[];
  /** Содержимое каждого файла, названного после `--mcp-config`. */
  configs: Record<string, unknown>[];
  /** Содержимое файла `--settings`, если он есть. */
  settings?: Record<string, unknown>;
  /** Дописка к системному промпту — файлом или аргументом, как её получил CLI. */
  append: string;
  env: Record<string, string | undefined>;
}

async function launch(
  cwd: string,
  options: {
    platformMcp?: { ids: string[]; config: unknown };
    permissionPrompt?: boolean;
    profileNote?: string;
    platformEnv?: Record<string, string>;
    platformSettings?: Record<string, unknown>;
  },
): Promise<Seen> {
  const seen: Seen = { args: [], configs: [], append: '', env: {} };
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_command: string, args: string[], spawnOptions?: { env?: Seen['env'] }) => {
      seen.args = args;
      seen.env = spawnOptions?.env ?? {};
      args.forEach((arg, index) => {
        const value = (args[index + 1] ?? '').replace(/^"|"$/g, '');
        if (arg === '--append-system-prompt-file') seen.append = readFileSync(value, 'utf8');
        if (arg === '--append-system-prompt') seen.append = value;
        if (arg === '--settings') {
          seen.settings = JSON.parse(readFileSync(value, 'utf8')) as Record<string, unknown>;
        }
        if (arg !== '--mcp-config') return;
        seen.configs.push(JSON.parse(readFileSync(value, 'utf8')) as Record<string, unknown>);
      });
      const child = new FakeChild();
      queueMicrotask(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child;
    },
  }));
  const { ChatRun } = await import('./ChatRunner.ts');
  await new ChatRun().start(
    {
      prompt: 'ok',
      cwd,
      platformArgs: ['--strict-mcp-config'],
      ...(options.platformMcp ? { platformMcp: options.platformMcp } : {}),
      ...(options.profileNote ? { profileNote: options.profileNote } : {}),
      ...(options.platformEnv ? { platformEnv: options.platformEnv } : {}),
      ...(options.platformSettings ? { platformSettings: options.platformSettings } : {}),
      ...(options.permissionPrompt
        ? {
            permissionMode: 'default',
            permissionPrompt: { runId: 'r1', baseUrl: 'http://127.0.0.1:1' },
          }
        : {}),
    },
    () => undefined,
  );
  return seen;
}

const GITLAB = { type: 'http', url: 'https://gitlab.example/mcp' };

describe('ChatRunner: MCP-серверы локального прогона', () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'cc-runner-localmcp-'));
  });
  afterEach(() => {
    vi.doUnmock('node:child_process');
    rmSync(cwd, { recursive: true, force: true });
  });

  it('выбранные серверы едут своим --mcp-config, записи как в файле настроек', async () => {
    const seen = await launch(cwd, {
      platformMcp: { ids: ['gitlab'], config: { mcpServers: { gitlab: GITLAB } } },
    });
    expect(seen.args).toContain('--strict-mcp-config');
    expect(seen.configs).toEqual([{ mcpServers: { gitlab: GITLAB } }]);
  });

  /**
   * Лёгкий профиль группы (1.2): строка группе доходит до дописки системного
   * промпта, а снятие подключений claude.ai — до окружения процесса CLI.
   */
  it('профиль группы: строка — в дописке, ENABLE_CLAUDEAI_MCP_SERVERS — в окружении', async () => {
    const seen = await launch(cwd, {
      platformMcp: { ids: ['gitlab'], config: { mcpServers: { gitlab: GITLAB } } },
      profileNote: 'MCP servers in this run: gitlab.',
      platformEnv: { ENABLE_CLAUDEAI_MCP_SERVERS: 'false' },
    });
    expect(seen.append).toContain('MCP servers in this run: gitlab.');
    expect(seen.env.ENABLE_CLAUDEAI_MCP_SERVERS).toBe('false');
  });

  it('перечень навыков группы едет файлом --settings, без него файла нет', async () => {
    const skillOverrides = { dataviz: 'name-only' };
    const seen = await launch(cwd, { platformSettings: { skillOverrides } });
    expect(seen.settings).toEqual({ skillOverrides });
    expect((await launch(cwd, {})).settings).toBeUndefined();
  });

  it('ничего не выбрано — флага --mcp-config нет вовсе', async () => {
    const seen = await launch(cwd, {});
    expect(seen.args).not.toContain('--mcp-config');
    const empty = await launch(cwd, { platformMcp: { ids: [], config: { mcpServers: {} } } });
    expect(empty.args).not.toContain('--mcp-config');
  });

  it('рядом с брокером прав: два файла, у брокера свой сервер, у выбора свой', async () => {
    const seen = await launch(cwd, {
      permissionPrompt: true,
      platformMcp: { ids: ['gitlab'], config: { mcpServers: { gitlab: GITLAB } } },
    });
    expect(seen.configs).toHaveLength(2);
    const names = seen.configs.map((config) => Object.keys(config.mcpServers as object));
    expect(names).toContainEqual(['gitlab']);
    expect(names).toContainEqual(['perm-guard']);
  });
});
