import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AdapterCaps, AdapterEvent, SessionHandle, SessionSpec } from '../adapter.types.ts';
import type { RpcAdapter } from '../rpc-stdio/rpc-adapter.ts';
import {
  EventTap,
  HOOK_LOG,
  liveRoot,
  livePin,
  liveSpec,
  type LiveRoot,
} from './__fixtures__/live.ts';
import {
  installRpcScript,
  readRpcDump,
  RPC_REPLAY,
  sentRpcMethod,
  withBinFirst,
} from './__fixtures__/rpc-replay.ts';
import { expectViewMatchesPump } from './__fixtures__/view-check.ts';
import { ioFault } from './__fixtures__/io-fault.ts';

// Сбой записи ввода — только на границе ФС; по умолчанию выключен (`ioFault.sends = 0`).
vi.mock('node:fs', async (orig) =>
  (await import('./__fixtures__/io-fault.ts')).faultyFs(await orig<typeof import('node:fs')>()),
);
import { ACP_PROFILES, type AcpProfile } from './__fixtures__/profiles/acp.ts';

/**
 * Набор соответствия переходников поверх ACP (Gemini CLI 0.66, Kimi Code 2.4.1; 03 §CLI adapter,
 * P121): записи живого CLI в контейнере проигрывает подставной CLI (`replay-rpc.mjs`) — настоящий
 * запуск переходника, его файлы сеанса, настоящий разбор потока, без CLI, модели и сети. Каждая
 * объявленная возможность — свой случай; защита ядра (хук или оверлей) — случай с отказом push.
 */

type BoolCap = {
  // `-?`: необязательная возможность (`loginLost`, этап 12) не даёт ключу `undefined`.
  [K in keyof AdapterCaps]-?: Exclude<AdapterCaps[K], undefined> extends boolean ? K : never;
}[keyof AdapterCaps];

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

interface Run {
  adapter: RpcAdapter;
  handle: SessionHandle;
  tap: EventTap;
  spec: SessionSpec;
  live: LiveRoot;
  dump: string;
}

const roots: LiveRoot[] = [];
const open: Run[] = [];

/** Сеансы случая закрываются в его конце, параллельно: по одному в afterAll — дольше таймаута. */
async function stopOpen(how: 'soft' | 'tree'): Promise<void> {
  await Promise.all(
    open.splice(0).map((run) => run.adapter.stop(run.handle, how).catch(() => undefined)),
  );
}

afterAll(async () => {
  await stopOpen('tree');
  for (const live of roots) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

async function replay(
  p: AcpProfile,
  fixture: string,
  resume?: (spec: SessionSpec) => NonNullable<SessionSpec['resume']>,
  mcpServers?: SessionSpec['mcpServers'],
): Promise<Run> {
  const live = liveRoot(`acp-${p.id}-`);
  roots.push(live);
  const bin = join(live.root, 'bin');
  installRpcScript(bin, p.command, RPC_REPLAY);
  const dump = join(live.root, 'dump.json');
  const base = liveSpec(live);
  const pin = livePin(live, { REPLAY_FIXTURE: fixture, REPLAY_DUMP: dump });
  const spec: SessionSpec = {
    ...base,
    coreHook: `${process.execPath} ${HOOK_LOG} core`,
    permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    endpoint: p.endpoint,
    env: { pin: withBinFirst(pin, bin) },
  };
  if (resume) spec.resume = resume(spec);
  if (mcpServers) spec.mcpServers = mcpServers;
  const adapter = p.make({ pollMs: 10 });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(launched.reason);
  const run = {
    adapter,
    handle: launched.handle,
    tap: new EventTap(adapter, launched.handle),
    spec,
    live,
    dump,
  };
  open.push(run);
  return run;
}

const ended = (e: AdapterEvent): e is Extract<AdapterEvent, { type: 'turn.ended' }> =>
  e.type === 'turn.ended';

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

/** Отказ push защитой ядра: вызов назван, результат — ошибка с текстом, ход дошёл до конца. */
async function blockedPush(p: AcpProfile): Promise<Run> {
  const r = await replay(p, p.fixtures.blocked);
  await r.adapter.send(r.handle, 'run git push', A);
  const end = await r.tap.until(ended);
  const requested = r.tap.seen.find((e) => e.type === 'tool.requested');
  expect(requested, r.tap.seen.map((e) => e.type).join(',')).toMatchObject({ name: p.shellTool });
  const result = r.tap.seen.find((e) => e.type === 'tool.result');
  expect(result).toMatchObject({ isError: true });
  expect(result?.type === 'tool.result' ? result.outcome?.errorText : null).toMatch(/denied/);
  expect(end).toMatchObject({ isError: false, text: 'DONE_AFTER_TOOL', attribution: A });
  return r;
}

interface AcpCase {
  name: string;
  /** Возможность, которую случай доказывает (P121); случай идёт, только если она объявлена. */
  exercises: BoolCap | null;
  run(p: AcpProfile): Promise<void>;
}

/** Серверы шага с записью сервера права: переносится только первый (право — строкой ACP). */
const STEP_MCP: SessionSpec['mcpServers'] = {
  'step-srv': { command: 'node', args: ['s.mjs'], env: { T: 'x' } },
  'agentdeck-permit': { command: 'node', args: ['p.mjs'] },
};

async function mcpSent(p: AcpProfile): Promise<Record<string, unknown>[]> {
  const r = await replay(p, p.fixtures.basic, undefined, STEP_MCP);
  await r.adapter.send(r.handle, 'say one', A);
  await r.tap.until(ended);
  const sent = await sentRpcMethod(r.dump, 'session/new');
  return (sent.params as { mcpServers?: Record<string, unknown>[] }).mcpServers ?? [];
}

const CASES: AcpCase[] = [
  {
    name: 'mcp: a step server reaches session/new in the ACP shape (env as a name/value list)',
    exercises: 'mcp',
    async run(p) {
      expect(await mcpSent(p)).toContainEqual({
        name: 'step-srv',
        command: 'node',
        args: ['s.mjs'],
        env: [{ name: 'T', value: 'x' }],
      });
    },
  },
  {
    name: 'strict MCP: session/new carries exactly the step servers, the permit server stays out',
    exercises: 'strictMcp',
    async run(p) {
      expect((await mcpSent(p)).map((s) => s.name)).toEqual(['step-srv']);
    },
  },
  {
    name: 'stream: text arrives as deltas before the turn ends',
    exercises: 'stream',
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      const end = await r.tap.until(ended);
      const before = r.tap.seen.slice(0, r.tap.seen.indexOf(end));
      const text = before.map((e) => (e.type === 'text.delta' ? e.text : '')).join('');
      expect(text).toBe('ANSWER_ONE');
      expect(end).toMatchObject({ isError: false, text: 'ANSWER_ONE' });
      const usage = r.tap.seen.find((e) => e.type === 'usage');
      if (p.usage) expect(usage).toMatchObject({ input: 10, output: 2 });
      else expect(usage).toBeUndefined();
    },
  },
  {
    name: 'attribution: each turn ends under the command that started it',
    exercises: 'attribution',
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: A, text: 'ANSWER_ONE' });
      await r.adapter.send(r.handle, 'SECOND_TURN say two', B);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: B, text: 'ANSWER_TWO' });
    },
  },
  {
    name: 'session view: the replay of stdout.log yields what the pump gave the core, human turns in place',
    exercises: 'stream',
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      await r.tap.until(ended);
      await r.adapter.send(r.handle, 'SECOND_TURN say two', B);
      await r.tap.until(ended);
      expectViewMatchesPump(r.adapter, r.spec.dir, r.tap.seen, [
        { said: 'FIRST_TURN say one', answer: 'ANSWER_ONE' },
        { said: 'SECOND_TURN say two', answer: 'ANSWER_TWO' },
      ]);
    },
  },
  {
    name: 'session view: a send whose core-io record failed shifts no request id in the replay',
    exercises: 'stream',
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      // Запись отправки упала (диск): ход не ушёл в CLI, его нет и в записи ввода — повтор
      // stdout.log его не увидит, значит и живой диалект не должен был тратить на него id.
      ioFault.sends = 1;
      try {
        await expect(r.adapter.send(r.handle, 'LOST_TURN never sent', A)).rejects.toThrow(
          /injected core-io append failure/,
        );
      } finally {
        ioFault.sends = 0;
      }
      await r.adapter.send(r.handle, 'FIRST_TURN say one', B);
      expect(await r.tap.until(ended)).toMatchObject({ attribution: B, text: 'ANSWER_ONE' });
      expectViewMatchesPump(r.adapter, r.spec.dir, r.tap.seen, [
        { said: 'FIRST_TURN say one', answer: 'ANSWER_ONE' },
      ]);
    },
  },
  {
    name: 'denyOverlay: push refused by the session policy, the policy file closes it by prefix and by words',
    exercises: 'denyOverlay',
    run: async (p) => {
      const r = await blockedPush(p);
      const guard = p.guard(r.spec.dir);
      expect(guard).toContain('commandPrefix = "git push"');
      expect(guard).toMatch(/commandRegex = ".*git.*push/);
    },
  },
  {
    name: 'preToolHooks: push refused by the core hook, the session config runs it fail-closed',
    exercises: 'preToolHooks',
    run: async (p) => {
      const r = await blockedPush(p);
      const requested = r.tap.seen.find((e) => e.type === 'tool.requested');
      // Вход вызова восстановлен из строки ACP: без него журнал и судья видят пустой вызов.
      expect(requested).toMatchObject({ input: { command: 'git push origin main' } });
      const guard = p.guard(r.spec.dir);
      expect(guard).toContain(JSON.stringify(`${r.spec.coreHook} || exit 2`));
      expect(guard).toContain('event = "PreToolUse"');
    },
  },
  {
    name: 'permit road: the ask carries the command, the core answer goes back as allow once',
    exercises: null,
    run: async (p) => {
      const r = await replay(p, p.fixtures.permit);
      await r.adapter.send(r.handle, 'run git status', A);
      const ask = await r.tap.until((e) => e.type === 'permit.request');
      if (ask.type !== 'permit.request') throw new Error('no ask');
      const read = r.adapter.permitCodec.read(ask.raw);
      expect(read?.call).toEqual({ tool: p.shellTool, input: { command: 'git status' } });
      expect(r.adapter.mapPermission(read!.call)).toMatchObject({
        action: 'exec',
        argv: ['git', 'status'],
        argvExact: true,
      });
      await r.adapter.answerPermit!(
        r.handle,
        ask.requestId,
        r.adapter.permitCodec.render({ allow: true, input: read!.call.input }),
      );
      const end = await r.tap.until(ended);
      expect(end).toMatchObject({ isError: false, text: 'DONE_AFTER_TOOL' });
      expect(r.tap.seen.find((e) => e.type === 'tool.result')).toMatchObject({ isError: false });
      const reply = readRpcDump(r.dump).stdin.find((m) => m.id === 0 && m.result !== undefined);
      expect(reply).toMatchObject({
        result: { outcome: { outcome: 'selected', optionId: p.allowOnce } },
      });
    },
  },
  {
    name: 'resume: an owned conversation goes out as session/load of that id, no new session; a forged id never starts the CLI',
    exercises: 'resume',
    run: async (p) => {
      const rp = p.resume;
      if (!rp) throw new Error(`${p.id} declares resume without a resume profile`);
      let id = '';
      const r = await replay(p, p.fixtures.basic, (spec) => {
        const from = join(spec.dir, '..', 'prior');
        id = rp.seed(from, spec.cwd);
        return { conversationId: id, from };
      });
      const sent = await sentRpcMethod(r.dump, rp.method);
      expect(sent.params).toMatchObject({ [rp.idParam]: id, cwd: r.spec.cwd });
      expect(readRpcDump(r.dump).stdin.map((m) => m.method)).not.toContain('session/new');
      await expect(
        replay(p, p.fixtures.basic, (spec) => {
          const from = join(spec.dir, '..', 'prior');
          rp.seed(from, spec.cwd);
          return { conversationId: rp.forged, from };
        }),
      ).rejects.toThrow(/^resume_not_owned/);
      expect(existsSync(join(roots.at(-1)!.root, 'dump.json'))).toBe(false);
    },
  },
  {
    name: 'session files: argv as recorded, every file inside the session dir, the human home untouched',
    exercises: null,
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      await r.tap.until(ended);
      expect(readRpcDump(r.dump).argv).toEqual(p.argv);
      const written = files(r.spec.dir).filter((f) => /gemini-home|kimi-home/.test(f));
      expect(written.length).toBeGreaterThan(0);
      for (const f of written) expect(relative(resolve(r.spec.dir), f)).not.toMatch(/^\.\./);
      expect(files(r.live.home)).toEqual([]);
    },
  },
];

for (const profile of ACP_PROFILES) {
  describe(`adapter conformance (ACP) — ${profile.id} over its recorded streams`, () => {
    const caps = profile.make({}).caps;
    for (const c of CASES) {
      it.skipIf(c.exercises !== null && !caps[c.exercises])(
        c.name,
        async () => {
          expect.hasAssertions();
          try {
            await c.run(profile);
          } finally {
            await stopOpen('soft');
          }
        },
        60_000,
      );
    }

    it('P121: every boolean cap it declares has a case here', () => {
      const declared = (Object.keys(caps) as (keyof AdapterCaps)[]).filter((k) => caps[k] === true);
      const covered = new Set(CASES.map((c) => c.exercises));
      for (const cap of declared) expect(covered.has(cap as BoolCap), `cap ${cap}`).toBe(true);
    });
  });
}
