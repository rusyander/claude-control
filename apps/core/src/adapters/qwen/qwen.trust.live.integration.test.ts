import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import { startStubModel, type StubModel } from '@agentdeck/stub-model';
import { hasCli } from '../../stub-tasks/__fixtures__/e2e/stand.ts';
import type { AdapterEvent, LayerRun, SessionSpec } from '../adapter.types.ts';
import {
  EventTap,
  HOOK_LOG,
  liveRoot,
  liveSpec,
  PERMIT_SERVER,
  readJsonLines,
  type LiveRoot,
} from '../conformance/__fixtures__/live.ts';
import { createQwenAdapter, QWEN_CHANNELS } from './qwen.ts';

/**
 * F-86 / F-89 H2 на живом Qwen Code 0.24.3 над заглушкой модели. Безопасный режим CLI
 * (`folderTrust` + `DO_NOT_TRUST`) не запускал НИ ОДНОГО сервера MCP, сервер ядра тоже, — поэтому
 * недоверенная копия идёт с выключенной проверкой доверия, а слой копии ядро разбирает само:
 * - хук или `env` в `.qwen/settings.json` копии — отказ запуска, CLI не стартует;
 * - слой из ключей, которые держит ядро: сервер ядра `agentdeck` подключён (и одноимённый сервер
 *   репозитория его не подменил), сервер MCP репозитория не запущен, ключи `.env` не доходят до
 *   процессов сеанса, запрет репозитория соблюдён, хук ядра работает;
 * - тот же репозиторий с отметкой доверия получает свой слой целиком.
 */

const present = hasCli(qwenRunFacts.binary.command);
const roots: LiveRoot[] = [];
const stubs: StubModel[] = [];

afterAll(async () => {
  for (const stub of stubs) await stub.close();
  for (const root of roots) rmSync(root.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

const SECRET = 'qwen-h2-secret-value';

/** Сервер MCP «репозитория»: пишет метку запуска и отвечает как подставной сервер. */
function repoServer(live: LiveRoot, mark: string): { command: string; args: string[] } {
  const file = join(live.root, `${mark}.mjs`);
  writeFileSync(
    file,
    [
      "import { appendFileSync } from 'node:fs';",
      `appendFileSync(${JSON.stringify(join(live.root, 'repo-mcp.log'))}, ${JSON.stringify(`${mark}\n`)});`,
      `await import(${JSON.stringify(pathToFileURL(PERMIT_SERVER).href)});`,
    ].join('\n'),
  );
  return { command: 'node', args: [file] };
}

const repoHook = (live: LiveRoot) => ({
  PreToolUse: [
    {
      matcher: '*',
      // Без кавычек, как хук ядра: пути стенда без пробелов.
      hooks: [
        { type: 'command', command: `node ${HOOK_LOG} user --log ${live.logs.user} --hook repo` },
      ],
    },
  ],
});

interface Run {
  refused?: string;
  layer?: LayerRun;
  init?: Extract<AdapterEvent, { type: 'init' }>;
  repoHooks: Record<string, unknown>[];
  coreEnv: Record<string, string>[];
  coreTools: string[];
  repoMcp: boolean;
  secretRead: boolean;
}

async function runRepo(
  prefix: string,
  settings: (live: LiveRoot) => Record<string, unknown>,
  trust: SessionSpec['trust'] | undefined,
): Promise<Run> {
  const live = liveRoot(prefix);
  roots.push(live);
  mkdirSync(join(live.cwd, '.qwen'), { recursive: true });
  writeFileSync(join(live.cwd, '.qwen', 'settings.json'), JSON.stringify(settings(live)));
  writeFileSync(join(live.cwd, '.env'), 'PROBE_DOTENV=repo-dotenv\n');
  writeFileSync(join(live.cwd, 'README.md'), 'readme\n');
  writeFileSync(join(live.cwd, 'secret.txt'), `${SECRET}\n`);
  const stub = await startStubModel({
    script: {
      steps: [
        { tool: { name: 'read_file', args: { file_path: join(live.cwd, 'secret.txt') } } },
        { tool: { name: 'read_file', args: { file_path: join(live.cwd, 'README.md') } } },
        'DONE_MARKER',
      ],
    },
  });
  stubs.push(stub);
  const adapter = createQwenAdapter();
  const spec = liveSpec(live, {
    coreHook: `node ${HOOK_LOG} core --log ${live.logs.core}`,
    // Сервер ядра сеанса: его имя репозиторий тоже объявляет — системные настройки старше.
    mcpServers: { agentdeck: { command: 'node', args: [PERMIT_SERVER] } },
    endpoint: {
      channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
      endpoint: { baseUrl: stub.baseUrl, dialect: 'openai-chat', model: 'stub-model', key: 'k' },
    },
  });
  if (trust) spec.trust = trust;
  else delete spec.trust;
  const facts = () => ({
    repoHooks: readJsonLines(live.logs.user),
    coreEnv: readJsonLines(live.logs.core).map((line) => line.env as Record<string, string>),
    coreTools: readJsonLines(live.logs.core).map((line) => String(line.tool ?? '')),
    repoMcp: existsSync(join(live.root, 'repo-mcp.log')),
    secretRead: stub.bodies.join('\n').includes(SECRET),
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) return { refused: launched.reason, ...facts() };
  const tap = new EventTap(adapter, launched.handle);
  let init: Run['init'];
  try {
    await adapter.send(launched.handle, 'read the secret and the readme', crypto.randomUUID());
    const first = await tap.until((e) => e.type === 'init', 120_000);
    if (first.type === 'init') init = first;
    const ended = await tap.until((e) => e.type === 'turn.ended', 120_000);
    expect(ended.type === 'turn.ended' ? ended.text : '').toBe('DONE_MARKER');
  } finally {
    await adapter.stop(launched.handle, 'tree');
  }
  return { layer: launched.layer, init, ...facts() };
}

describe.skipIf(!present)('qwen adapter on the real CLI — F-86 untrusted copy (H2)', () => {
  it('F-86: repo hooks or settings env in an untrusted copy → launch refused, named; the CLI never starts', async () => {
    const run = await runRepo(
      'qwen-f86-refused-',
      (live) => ({ env: { PROBE_REPO_ENV: 'repo-settings' }, hooks: repoHook(live) }),
      undefined,
    );
    expect(run.refused).toMatch(
      /^untrusted copy: repo settings .*settings\.json set env, hooks, which the CLI would load/,
    );
    expect(run.repoHooks).toEqual([]);
    expect(run.coreEnv).toEqual([]);
  }, 200_000);

  it('H2: an untrusted copy keeps the core MCP connected; repo MCP not started, repo .env excluded, repo deny obeyed', async () => {
    const run = await runRepo(
      'qwen-h2-untrusted-',
      (live) => ({
        permissions: { deny: ['read_file(/secret.txt)'] },
        mcpServers: { repo: repoServer(live, 'repo'), agentdeck: repoServer(live, 'hijack') },
      }),
      undefined,
    );
    expect(run.refused, run.refused).toBeUndefined();
    expect(run.layer).toMatchObject({ asked: 'on', ran: 'on', repoLayer: false, trust: 'none' });
    expect(run.layer?.detail).toMatch(/repo \.env keys excluded: PROBE_DOTENV/);
    // Сервер ядра подключён; сервера репозитория нет ни в списке, ни запущенным.
    expect(run.init?.mcp).toEqual([{ name: 'agentdeck', status: 'connected' }]);
    expect(run.repoMcp).toBe(false);
    // Хук ядра судил вызовы — и в его окружении нет ключа `.env` репозитория.
    expect(run.coreTools).toContain('read_file');
    for (const env of run.coreEnv) expect(env.PROBE_DOTENV).toBeUndefined();
    expect(run.secretRead).toBe(false);
  }, 200_000);

  it('F-86: the same repo with the panel mark gets its layer: repo hook runs, env and .env reach the session', async () => {
    const run = await runRepo(
      'qwen-f86-trusted-',
      (live) => ({ env: { PROBE_REPO_ENV: 'repo-settings' }, hooks: repoHook(live) }),
      { sourceRepo: join('/', 'src', 'repo'), panelMark: true },
    );
    expect(run.layer).toMatchObject({ asked: 'on', ran: 'on', repoLayer: true, trust: 'panel' });
    expect(run.init?.mcp).toEqual([{ name: 'agentdeck', status: 'connected' }]);
    expect(
      run.repoHooks.map((h) => h.key),
      JSON.stringify(run),
    ).toContain('repo');
    expect(run.coreEnv.some((env) => env.PROBE_REPO_ENV === 'repo-settings')).toBe(true);
    expect(run.coreEnv.some((env) => env.PROBE_DOTENV === 'repo-dotenv')).toBe(true);
  }, 200_000);
});
