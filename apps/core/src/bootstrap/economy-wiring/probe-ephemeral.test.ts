import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionSpec } from '../../adapters/index.ts';
import { createAdapterRegistry } from '../../adapters/index.ts';
import { planClaude } from '../../adapters/claude/claude.ts';
import { createCodexDialect } from '../../adapters/codex/app-server.ts';
import { mapCodexPermission } from '../../adapters/codex/permission.ts';
import { planGemini } from '../../adapters/gemini/gemini.ts';
import { planGoose } from '../../adapters/goose/goose.ts';
import { planKimi } from '../../adapters/kimi/kimi.ts';
import { planOpencode } from '../../adapters/opencode/opencode.ts';
import { planQwen } from '../../adapters/qwen/qwen.ts';
import { trustedLayer } from '../../adapters/sdk-stream/layer-run.ts';
import { probeOnStub } from './context.ts';

/**
 * Проба базы не оставляет разговора в хранилище CLI (s11 w3): иначе панель, которая читает это
 * хранилище, показывает пробу строкой «AGENTDECK_BASE_PROBE <id>» в списке чатов человека.
 * Шов — `probeOnStub`: запускает сеанс с `ephemeral` и отказывает CLI, который не умеет сеанс
 * без следа. По CLI — чем именно план держит след: флагом CLI или домом CLI внутри каталога
 * сеанса. Живое доказательство на настоящих CLI — `probe-trace.live.integration.test.ts`.
 */

/** Как каждый переходник реестра держит сеанс без следа; новый CLI краснит таблицу. */
const EPHEMERAL: Record<string, CliAdapter['ephemeral']> = {
  claude: 'flag',
  qwen: 'flag',
  codex: 'flag',
  goose: 'session-home',
  opencode: 'session-home',
  kimi: 'session-home',
  gemini: 'session-home',
  // Без судьи ядра (`gateless`) сеанс не запускается вовсе — пробе нечего запускать.
  aider: undefined,
  continue: undefined,
  cursor: undefined,
};

function spec(over: Partial<SessionSpec> = {}): SessionSpec {
  const cwd = join(tmpdir(), 'probe-ephemeral-work');
  return {
    sessionId: '55555555-5555-4555-8555-555555555555',
    dir: join(tmpdir(), 'probe-ephemeral-session', 'base-probe'),
    cwd,
    brief: 'BRIEF',
    deny: { paths: [], commands: [], mcpTools: [], tools: [] },
    platform: { coreHome: join(cwd, '..', 'probe-ephemeral-core'), tokenFiles: [] },
    tools: 'none',
    mcpServers: {},
    layer: { hooks: 'on', skills: 'on' },
    env: { pin: {} },
    coreHook: 'node hook.mjs core',
    core: {
      taskId: 't',
      stepId: 's',
      stepKind: 'work',
      coreUrl: 'http://127.0.0.1:1',
      sessionToken: 'tok',
    },
    ...over,
  };
}

const traceless = (): SessionSpec => spec({ ephemeral: true });
const inside = (dir: string, path: string | undefined): boolean =>
  path !== undefined && !relative(dir, path).startsWith('..') && path !== dir;

/** Переходник, чей ход кончается сразу: запуск записывает спецификацию, остановка — режим. */
function fakeAdapter(ephemeral: CliAdapter['ephemeral']) {
  const launched: SessionSpec[] = [];
  const adapter = {
    id: 'claude',
    ...(ephemeral ? { ephemeral } : {}),
    launch: async (s: SessionSpec) => {
      launched.push(s);
      return { ok: true, handle: { sessionId: s.sessionId }, layer: {} };
    },
    send: async () => ({ dup: false }),
    events: async function* (): AsyncGenerator<AdapterEvent> {
      yield { type: 'turn.ended' } as AdapterEvent;
    },
    stop: async () => ({ how: 'exited', residual: [] }),
  } as unknown as CliAdapter;
  return { adapter, launched };
}

const BIND = { channel: { via: 'env' } as never, dialect: 'anthropic-messages' as const };

describe('base probe seam — the probe session persists no conversation', () => {
  it('probeOnStub launches the session traceless (ephemeral) on its own stub address', async () => {
    const { adapter, launched } = fakeAdapter('flag');
    const trace = await probeOnStub(adapter, spec(), BIND, 10_000);
    expect(launched).toHaveLength(1);
    expect(launched[0]!.ephemeral).toBe(true);
    expect(launched[0]!.endpoint?.endpoint.key).toBe('base-probe');
    expect(trace.brief).toBe(`AGENTDECK_BASE_PROBE ${spec().sessionId}`);
  });

  it('probeOnStub refuses a CLI with no traceless session before anything launches', async () => {
    const { adapter, launched } = fakeAdapter(undefined);
    await expect(probeOnStub(adapter, spec(), BIND, 10_000)).rejects.toThrow(
      /cannot run a traceless session/,
    );
    expect(launched).toHaveLength(0);
  });

  it('every registry adapter declares how it keeps a traceless session (gateless ones none)', () => {
    const declared = Object.fromEntries(
      createAdapterRegistry()
        .all()
        .map((a) => [a.id, a.ephemeral]),
    );
    expect(declared).toEqual(EPHEMERAL);
  });

  it('claude: --no-session-persistence only on a traceless session (stream-json -p keeps it valid)', () => {
    const plan = (s: SessionSpec) => planClaude(s, null, trustedLayer(s));
    const args = plan(traceless()).args;
    expect(args).toContain('--no-session-persistence');
    expect(args).toContain('-p');
    expect(plan(spec()).args).not.toContain('--no-session-persistence');
  });

  it('qwen: --chat-recording=false only on a traceless session', () => {
    const plan = (s: SessionSpec) => planQwen(s, null, trustedLayer(s));
    expect(plan(traceless()).args).toContain('--chat-recording=false');
    expect(plan(spec()).args.some((a) => a.startsWith('--chat-recording'))).toBe(false);
  });

  it('codex: thread/start asks an ephemeral thread only on a traceless session', () => {
    const threadStart = (ephemeral?: true): Record<string, unknown> => {
      const d = createCodexDialect({
        cwd: 'C:\\w',
        hookCommand: 'node hook.mjs',
        approvalPolicy: 'untrusted',
        sandbox: 'read-only',
        developerInstructions: 'BRIEF',
        permit: 'core',
        mapPermission: mapCodexPermission,
        ...(ephemeral ? { ephemeral } : {}),
      });
      const out = [...d.start()];
      const feed = (line: string) => out.push(...d.push(line).out);
      feed(JSON.stringify({ id: 1, result: { userAgent: 'codex' } }));
      feed(
        JSON.stringify({
          id: 2,
          result: {
            data: [
              {
                cwd: 'C:\\w',
                hooks: [
                  {
                    key: 'k',
                    eventName: 'preToolUse',
                    source: 'user',
                    command: 'node hook.mjs',
                    currentHash: 'sha256:a',
                  },
                ],
              },
            ],
          },
        }),
      );
      feed(JSON.stringify({ id: 3, result: { status: 'ok' } }));
      const line = out
        .map((o) => JSON.parse(o.line) as { method?: string; params?: Record<string, unknown> })
        .find((m) => m.method === 'thread/start');
      if (!line?.params) throw new Error(`no thread/start in ${out.map((o) => o.line).join('\n')}`);
      return line.params;
    };
    expect(threadStart(true).ephemeral).toBe(true);
    expect(threadStart().ephemeral).toBe(false);
  });

  it('session-home CLIs: every store variable of the plan lies inside the probe session dir', () => {
    const s = traceless();
    const stores: Record<string, Record<string, string | undefined>> = {
      goose: planGoose(s, null, trustedLayer(s)).env,
      opencode: planOpencode(s, null, trustedLayer(s)).env,
      kimi: planKimi(s, null, trustedLayer(s)).env,
      gemini: planGemini(s, null, trustedLayer(s)).env,
    };
    const named: Record<string, string[]> = {
      goose: ['GOOSE_PATH_ROOT'],
      opencode: ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'],
      kimi: ['KIMI_CODE_HOME'],
      gemini: ['GEMINI_CLI_HOME'],
    };
    for (const [id, env] of Object.entries(stores)) {
      expect(EPHEMERAL[id], id).toBe('session-home');
      for (const name of named[id]!)
        expect(inside(s.dir, env[name]), `${id} ${name}=${env[name]}`).toBe(true);
    }
  });
});
