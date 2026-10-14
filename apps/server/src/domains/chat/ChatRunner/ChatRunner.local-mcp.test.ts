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
}

async function launch(
  cwd: string,
  options: { platformMcp?: { ids: string[]; config: unknown }; permissionPrompt?: boolean },
): Promise<Seen> {
  const seen: Seen = { args: [], configs: [] };
  vi.resetModules();
  vi.doMock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    spawn: (_command: string, args: string[]) => {
      seen.args = args;
      args.forEach((arg, index) => {
        if (arg !== '--mcp-config') return;
        const path = (args[index + 1] ?? '').replace(/^"|"$/g, '');
        seen.configs.push(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>);
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
