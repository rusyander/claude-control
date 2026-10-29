import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent, SessionSpec } from '../adapter.types.ts';
import {
  EventTap,
  hookCommand,
  liveRoot,
  liveSpec,
  readJsonLines,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from './claude.ts';

/**
 * F-86 на живом Claude Code над заглушкой модели: копия недоверенного репозитория, запрошенная
 * в слое `on`, идёт в `observe` — хуки репозитория (`.claude/settings.json` и
 * `settings.local.json`) не исполняются, их `env` не доходит до процессов сеанса, сервер из
 * `.mcp.json` не поднимается; запуск называет понижение. Тот же репозиторий с отметкой
 * доверия (панели или самого CLI по пути ИСХОДНОГО репозитория) идёт в `on`.
 */

const present = hasCli(claudeRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

interface Run {
  launched: { layer?: unknown; argv: string[] };
  init: Extract<AdapterEvent, { type: 'init' }> | undefined;
  repoHooks: Record<string, unknown>[];
  coreEnv: Record<string, string>[];
}

/** Репозиторий с хуками, `env` и сервером MCP в файлах проекта; одна реплика через переходник. */
async function runRepo(
  prefix: string,
  trust: (live: LiveRoot) => SessionSpec['trust'],
): Promise<Run> {
  const live = liveRoot(prefix);
  roots.push(live);
  const mark = trust(live);
  const repoHook = (key: string) => [
    {
      matcher: '*',
      hooks: [{ type: 'command', command: `${hookCommand('user', live.logs.user)} --hook ${key}` }],
    },
  ];
  writeJson(join(live.cwd, '.claude', 'settings.json'), {
    env: { PROBE_REPO_ENV: 'repo-settings' },
    enableAllProjectMcpServers: true,
    hooks: { UserPromptSubmit: repoHook('settings'), PreToolUse: repoHook('settings') },
  });
  writeJson(join(live.cwd, '.claude', 'settings.local.json'), {
    env: { PROBE_LOCAL_ENV: 'repo-local' },
    hooks: { UserPromptSubmit: repoHook('local') },
  });
  writeJson(join(live.cwd, '.mcp.json'), {
    mcpServers: { 'repo-mcp': { command: process.execPath, args: ['-e', ''] } },
  });
  writeFileSync(join(live.cwd, 'README.md'), 'readme\n');
  const stub = await startStubModel({
    script: {
      steps: [
        { tool: { name: 'Read', args: { file_path: join(live.cwd, 'README.md') } } },
        'DONE_MARKER',
      ],
    },
  });
  stubs.push(stub);
  const adapter = createClaudeAdapter();
  const spec = liveSpec(live, {
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: {
        baseUrl: stub.baseUrl,
        dialect: 'anthropic-messages',
        model: 'stub-model',
        key: 'k',
      },
    },
    coreHook: hookCommand('core', live.logs.core),
  });
  if (mark) spec.trust = mark;
  else delete spec.trust;
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const tap = new EventTap(adapter, launched.handle);
  try {
    await adapter.send(launched.handle, 'read the readme', crypto.randomUUID());
    const ended = await tap.until((e) => e.type === 'turn.ended', 120_000);
    expect(ended.type === 'turn.ended' ? ended.text : '').toBe('DONE_MARKER');
  } finally {
    await adapter.stop(launched.handle, 'soft');
  }
  const init = tap.seen.find(
    (e): e is Extract<AdapterEvent, { type: 'init' }> => e.type === 'init',
  );
  const core = readJsonLines(live.logs.core);
  return {
    launched: {
      layer: (launched as { layer?: unknown }).layer,
      argv: launched.handle.spawned.argv,
    },
    init,
    repoHooks: readJsonLines(live.logs.user),
    coreEnv: core.map((line) => line.env as Record<string, string>),
  };
}

const source = (live: LiveRoot): string => join(live.root, 'source');

describe.skipIf(!present)('claude adapter on the real CLI — F-86 untrusted copy', () => {
  it('F-86: an untrusted copy asking layer on runs in observe; repo hooks, env and MCP never load', async () => {
    // Отметка CLI есть, но у КОПИИ, а не у исходного репозитория: доверия это не даёт.
    const run = await runRepo('claude-f86-untrusted-', (live) => {
      writeJson(join(live.home, '.claude.json'), {
        projects: { [live.cwd.replaceAll('\\', '/')]: { hasTrustDialogAccepted: true } },
      });
      return { sourceRepo: source(live), panelMark: false };
    });
    expect(run.launched.layer).toMatchObject({
      asked: 'on',
      ran: 'observe',
      repoLayer: false,
      trust: 'none',
    });
    const at = run.launched.argv.indexOf('--setting-sources');
    expect(at).toBeGreaterThan(-1);
    expect(run.launched.argv[at + 1]).toBe('');
    expect(run.repoHooks).toEqual([]);
    // Хук ядра сработал (PreToolUse на Read) — и в его окружении нет меток репозитория.
    expect(run.coreEnv.length).toBeGreaterThan(0);
    for (const env of run.coreEnv) {
      expect(env.PROBE_REPO_ENV).toBeUndefined();
      expect(env.PROBE_LOCAL_ENV).toBeUndefined();
    }
    expect(run.init).toBeDefined();
    expect(run.init?.mcp.map((s) => s.name)).not.toContain('repo-mcp');
  }, 200_000);

  it('F-86: the same repo with the panel mark runs in layer on; the repo layer loads', async () => {
    const run = await runRepo('claude-f86-panel-', (live) => ({
      sourceRepo: source(live),
      panelMark: true,
    }));
    expect(run.launched.layer).toMatchObject({
      asked: 'on',
      ran: 'on',
      repoLayer: true,
      trust: 'panel',
    });
    expect(run.launched.argv).not.toContain('--setting-sources');
    expect(run.repoHooks.map((h) => h.key)).toEqual(expect.arrayContaining(['settings', 'local']));
    expect(run.coreEnv.some((env) => env.PROBE_REPO_ENV === 'repo-settings')).toBe(true);
    expect(run.coreEnv.some((env) => env.PROBE_LOCAL_ENV === 'repo-local')).toBe(true);
    // Сервер `.mcp.json` не поднимается и в `on`: список MCP строгий (`--strict-mcp-config`).
    expect(run.init?.mcp.map((s) => s.name)).not.toContain('repo-mcp');
  }, 200_000);

  it("F-86: the CLI's own trust record for the source repo (other case, back slashes) runs layer on", async () => {
    const run = await runRepo('claude-f86-cli-', (live) => {
      // CLI пишет ключ так, как пришёл cwd: прямые косые, регистр — как набрал человек.
      const key = process.platform === 'win32' ? source(live).toUpperCase() : source(live);
      writeJson(join(live.home, '.claude.json'), {
        projects: { [key]: { hasTrustDialogAccepted: true } },
      });
      return { sourceRepo: source(live), panelMark: false };
    });
    expect(run.launched.layer).toMatchObject({
      asked: 'on',
      ran: 'on',
      repoLayer: true,
      trust: 'cli',
    });
    expect(run.repoHooks.length).toBeGreaterThan(0);
  }, 200_000);
});
