import { join } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
  readRpcMeta,
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
import { RPC_PROFILES, type RpcProfile } from './__fixtures__/profiles/index.ts';

/**
 * Набор соответствия переходников JSON-RPC по stdio (03 §CLI adapter, P121): записи живого CLI
 * проигрываются подставным CLI (`replay-rpc.mjs`) — настоящий переходник, настоящий разбор потока,
 * без CLI, модели и сети. Каждая объявленная возможность — свой случай; запись хранит версию CLI.
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

afterEach(() => stopOpen('soft'), 30_000);

afterAll(async () => {
  await stopOpen('tree');
  for (const live of roots) rmSync(live.root, { recursive: true, force: true, maxRetries: 5 });
}, 60_000);

/**
 * Запуск над записью. Подмены — строки времени записи на нынешние: команда хука первой (в ней
 * каталог сеанса), затем каталог и рабочая папка. `swapHook` — подменить команду хука в ответе CLI
 * на чужую (мутант доверия).
 */
async function replay(
  p: RpcProfile,
  fixture: string,
  extra: {
    swapHook?: true;
    waitMs?: number;
    /** Продолжение: строится по спеку сеанса (его рабочей папке), до запуска. */
    resume?: (spec: SessionSpec) => NonNullable<SessionSpec['resume']>;
    mcpServers?: SessionSpec['mcpServers'];
  } = {},
): Promise<Run> {
  const live = liveRoot(`rpc-${p.id}-`);
  roots.push(live);
  const bin = join(live.root, 'bin');
  installRpcScript(bin, p.command, RPC_REPLAY);
  const dump = join(live.root, 'dump.json');
  const base = liveSpec(live);
  const spec: SessionSpec = {
    ...base,
    coreHook: `${process.execPath} ${HOOK_LOG} core`,
    permitServer: { name: 'agentdeck-permit', tool: 'permit' },
    endpoint: p.endpoint,
  };
  const meta = readRpcMeta(fixture);
  const hook = p.hookCommand(spec);
  const rewrites = [
    [meta.hookCommand, extra.swapHook ? `${hook} --someone-else` : hook],
    [meta.dir, spec.dir],
    [meta.cwd, spec.cwd],
  ];
  const pin = livePin(live, {
    REPLAY_FIXTURE: fixture,
    REPLAY_DUMP: dump,
    REPLAY_REWRITE: JSON.stringify(rewrites),
    REPLAY_WAIT_MS: String(extra.waitMs ?? 20_000),
  });
  const final: SessionSpec = {
    ...spec,
    env: { pin: withBinFirst(pin, bin) },
    ...(extra.resume ? { resume: extra.resume(spec) } : {}),
    ...(extra.mcpServers ? { mcpServers: extra.mcpServers } : {}),
  };
  const adapter = p.make({ pollMs: 10 });
  const launched = await adapter.launch(final);
  if (!launched.ok) throw new Error(launched.reason);
  const run = {
    adapter,
    handle: launched.handle,
    tap: new EventTap(adapter, launched.handle),
    spec: final,
    dump,
  };
  open.push(run);
  return run;
}

const ended = (e: AdapterEvent): e is Extract<AdapterEvent, { type: 'turn.ended' }> =>
  e.type === 'turn.ended';

/**
 * Конец хода; вопросы о праве по дороге ядро разрешает. Так в записи `blocked` отказ остаётся
 * делом одного хука: CLI, что спрашивает раньше хука (Goose), получает «да» и всё равно не исполняет.
 */
async function endAllowingAsks(r: Run): Promise<Extract<AdapterEvent, { type: 'turn.ended' }>> {
  for (;;) {
    const ev = await r.tap.until((e) => e.type === 'permit.request' || ended(e));
    if (ended(ev)) return ev;
    if (ev.type !== 'permit.request') continue;
    const read = r.adapter.permitCodec.read(ev.raw);
    await r.adapter.answerPermit!(
      r.handle,
      ev.requestId,
      r.adapter.permitCodec.render({ allow: true, input: read?.call.input ?? {} }),
    );
  }
}

interface RpcCase {
  name: string;
  /** Возможности, которые случай доказывает (P121): объявленная без случая — красный. */
  exercises: BoolCap[];
  /** Случай про доверие хуку по протоколу: идёт, только когда у профиля есть `trustMethod`. */
  needsTrust?: true;
  run(p: RpcProfile): Promise<void>;
}

const CASES: RpcCase[] = [
  {
    name: 'stream: text arrives as deltas before the turn ends, usage is read',
    exercises: ['stream'],
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      const end = await r.tap.until(ended);
      const at = r.tap.seen.indexOf(end);
      const deltas = r.tap.seen.slice(0, at).filter((e) => e.type === 'text.delta');
      expect(deltas.map((e) => (e.type === 'text.delta' ? e.text : '')).join('')).toBe(
        'ANSWER_ONE',
      );
      expect(end).toMatchObject({ isError: false, text: 'ANSWER_ONE' });
      const usage = r.tap.seen.find((e) => e.type === 'usage');
      expect(usage, r.tap.seen.map((e) => e.type).join(',')).toBeDefined();
    },
  },
  {
    name: 'attribution: each turn ends under the command id that started it',
    exercises: ['attribution'],
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic);
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      const one = await r.tap.until(ended);
      await r.adapter.send(r.handle, 'SECOND_TURN say two', B);
      const two = await r.tap.until(ended);
      expect([one, two]).toMatchObject([
        { attribution: A, text: 'ANSWER_ONE' },
        { attribution: B, text: 'ANSWER_TWO' },
      ]);
    },
  },
  {
    name: 'session view: the replay of stdout.log yields what the pump gave the core, human turns in place',
    exercises: ['stream'],
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
    exercises: ['stream'],
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
    name: 'strict MCP: the CLI is given exactly the step servers, the permit server stays out',
    exercises: ['mcp', 'strictMcp'],
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic, {
        mcpServers: {
          'step-srv': { command: process.execPath, args: ['s.mjs'], env: { T: 'x' } },
          'agentdeck-permit': { command: process.execPath, args: ['p.mjs'] },
        },
      });
      await r.adapter.send(r.handle, 'FIRST_TURN say one', A);
      await r.tap.until(ended);
      expect(p.mcpNames(readRpcDump(r.dump), r.spec.dir)).toEqual(['step-srv']);
    },
  },
  {
    name: 'preToolHooks: our hook in the session file (trusted before the thread where the protocol asks), its refusal holds',
    exercises: ['preToolHooks'],
    run: async (p) => {
      const r = await replay(p, p.fixtures.blocked);
      await r.adapter.send(r.handle, 'publish', A);
      const end = await endAllowingAsks(r);
      expect(p.hookCommands(r.spec.dir)).toEqual([p.hookCommand(r.spec)]);
      if (p.trustMethod) {
        const methods = readRpcDump(r.dump).stdin.map((m) => m.method);
        const trust = methods.indexOf(p.trustMethod);
        expect(trust, methods.join(',')).toBeGreaterThanOrEqual(0);
        expect(trust).toBeLessThan(methods.indexOf(p.threadMethod));
      }
      const types = r.tap.seen.map((e) => e.type);
      if (p.blockedShows === 'nothing') {
        // Отказанная команда не дошла до исполнения: ни результата, ни вопроса о праве.
        expect(types).not.toContain('tool.result');
        expect(types).not.toContain('permit.request');
      } else {
        // Вопрос, если CLI задал его раньше хука, получил «да»; хук отказал — итог вызова ошибкой.
        expect(
          r.tap.seen.find((e) => e.type === 'tool.requested'),
          types.join(','),
        ).toMatchObject({ name: p.shellTool, input: { command: 'git push origin main' } });
        const results = r.tap.seen.filter((e) => e.type === 'tool.result');
        expect(results, types.join(',')).toHaveLength(1);
        expect(results[0]).toMatchObject({ isError: true });
      }
      expect(end).toMatchObject({ attribution: A, isError: false, text: 'BLOCKED_SEEN' });
    },
  },
  {
    name: 'resume: an owned conversation goes out as the CLI resume of that id, no new thread; a forged id never starts the CLI',
    exercises: ['resume'],
    run: async (p) => {
      const rp = p.resume;
      if (!rp) throw new Error(`${p.id} declares resume without a resume profile`);
      let id = '';
      const r = await replay(p, p.fixtures.basic, {
        resume: (spec) => {
          const from = join(spec.dir, '..', 'prior');
          id = rp.seed(from, spec.cwd);
          return { conversationId: id, from };
        },
      });
      const sent = await sentRpcMethod(r.dump, rp.method);
      expect((sent.params as Record<string, unknown>)[rp.idParam]).toBe(id);
      expect(readRpcDump(r.dump).stdin.map((m) => m.method)).not.toContain(p.threadMethod);
      await expect(
        replay(p, p.fixtures.basic, {
          resume: (spec) => {
            const from = join(spec.dir, '..', 'prior');
            rp.seed(from, spec.cwd);
            return { conversationId: rp.forged, from };
          },
        }),
      ).rejects.toThrow(/^resume_not_owned/);
      expect(existsSync(join(roots.at(-1)!.root, 'dump.json'))).toBe(false);
    },
  },
  {
    name: 'preToolHooks: a hook the CLI lists that is not ours is never trusted, no thread starts',
    exercises: ['preToolHooks'],
    needsTrust: true,
    run: async (p) => {
      const r = await replay(p, p.fixtures.basic, { swapHook: true, waitMs: 6000 });
      const err = await r.tap.until((e) => e.type === 'error' || ended(e), 15_000);
      expect(
        err,
        JSON.stringify({ seen: r.tap.seen, sent: readRpcDump(r.dump).stdin.map((m) => m.method) }),
      ).toMatchObject({ type: 'error', code: 'protocol' });
      const methods = readRpcDump(r.dump).stdin.map((m) => m.method);
      expect(methods).not.toContain(p.trustMethod);
      expect(methods).not.toContain(p.threadMethod);
    },
  },
];

for (const p of RPC_PROFILES) {
  describe(`rpc adapter conformance — ${p.id} over its recorded streams`, () => {
    it.each(
      CASES.filter(
        (c) => c.exercises.every((cap) => p.make({}).caps[cap]) && (!c.needsTrust || p.trustMethod),
      ).map((c) => [c.name, c] as const),
    )('%s', async (_name, c) => c.run(p), 60_000);

    // Право спрашивается строкой протокола: ядро видит вопрос, отвечает, CLI получает ответ.
    it('in-band permit: the ask reaches the core with the call, the answer reaches the CLI', async () => {
      const r = await replay(p, p.fixtures.permit);
      await r.adapter.send(r.handle, 'run a command', A);
      const ask = await r.tap.until((e) => e.type === 'permit.request');
      if (ask.type !== 'permit.request') throw new Error('unreachable');
      const read = r.adapter.permitCodec.read(ask.raw);
      expect(read).not.toBeNull();
      const mapped = r.adapter.mapPermission(read!.call);
      expect(mapped.argv).toEqual(['echo', 'hi']);
      const requested = r.tap.seen.find((e) => e.type === 'tool.requested');
      expect(requested).toMatchObject({ name: p.shellTool });
      await r.adapter.answerPermit!(
        r.handle,
        ask.requestId,
        r.adapter.permitCodec.render({ allow: true, input: read!.call.input }),
      );
      const end = await r.tap.until(ended);
      expect(end).toMatchObject({ attribution: A, isError: false, text: 'PERMIT_DONE' });
      // Итог вызова не потерян разбором потока.
      const result = r.tap.seen.find((e) => e.type === 'tool.result');
      expect(result).toMatchObject({ isError: false });
      // Ответ клиента на вопрос — в словах этого CLI («да» один раз), не в словах ядра.
      const replies = readRpcDump(r.dump).stdin.filter(
        (m) => m.method === undefined && m.result !== undefined,
      );
      expect(replies, JSON.stringify(replies)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ result: expect.objectContaining(p.permitReply) }),
        ]),
      );
    }, 60_000);
  });
}

describe('rpc adapter conformance — P121 every declared cap has a case', () => {
  it.each(RPC_PROFILES.map((p) => [p.id, p] as const))(
    '%s: each cap it declares is exercised',
    (_id, p) => {
      const caps = p.make({}).caps;
      for (const [cap, on] of Object.entries(caps)) {
        if (on !== true) continue;
        const covering = CASES.filter((c) => c.exercises.includes(cap as BoolCap));
        expect(
          covering.length,
          `cap ${cap} declared by ${p.id} has no rpc conformance case`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(RPC_PROFILES.map((p) => [p.id, p] as const))(
    '%s: every recording names the CLI version it was taken from',
    (_id, p) => {
      for (const file of Object.values(p.fixtures)) {
        const meta = readRpcMeta(file);
        expect(meta.version, file).toMatch(/\d+\.\d+\.\d+/);
        expect(meta.hookCommand, file).not.toBe('');
      }
    },
  );
});
