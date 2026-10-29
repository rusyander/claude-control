import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AdapterEvent, CliAdapter, SessionHandle, SessionSpec } from '../adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../claude/claude.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../qwen/qwen.ts';
import { EventTap, liveRoot, liveSpec } from '../conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  readDump,
  replayEnv,
} from '../conformance/__fixtures__/replay.ts';
import { sessionFile } from '../../session-host/protocol.ts';
import { IO_RECORD } from './io-record.ts';
import type { ReattachOutcome, SdkAdapter } from './sdk-adapter.ts';
import { sdkUserLine } from './session.ts';

/**
 * Сессия переживает ядро (01 §Sessions at core death, P89): прежнее ядро «умирает» (его насос
 * закрывает канал, хост и CLI живут), новый переходник прикрепляется к тому же хосту по каталогу
 * сеанса. Подставной CLI проигрывает запись живого CLI через настоящий хост — видно, что история
 * потока восстановлена без пропуска и дубля, а в stdin CLI не ушло ни одной лишней строки.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', model: 'stub-model', key: 'stub-key' };

interface Profile {
  id: string;
  command: string;
  make(): SdkAdapter;
  endpoint: SessionSpec['endpoint'];
}

const PROFILES: Profile[] = [
  {
    id: 'claude',
    command: 'claude',
    // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с явным флагом тестов (F-10).
    make: () => createClaudeAdapter({ pollMs: 20, unhookedForTests: true }),
    endpoint: {
      channel: CLAUDE_CHANNELS[0]!,
      endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' },
    },
  },
  {
    id: 'qwen',
    command: 'qwen',
    make: () => createQwenAdapter({ pollMs: 20, unhookedForTests: true }),
    endpoint: {
      channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
      endpoint: { ...ENDPOINT, dialect: 'openai-chat' },
    },
  },
];

const live = liveRoot('adp-reattach-');
const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];
afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree').catch(() => undefined);
});

let runs = 0;

async function launch(p: Profile, fixture: string, over: Partial<SessionSpec> = {}) {
  const bin = join(live.root, `bin-${p.id}`);
  mkdirSync(bin, { recursive: true });
  installReplay(bin, p.command);
  runs += 1;
  const dumpFile = join(live.root, `dump-${runs}.json`);
  const adapter = p.make();
  const base = liveSpec(live);
  const spec = liveSpec(live, {
    endpoint: p.endpoint,
    ...over,
    env: {
      pin: {
        ...base.env.pin,
        ...replayEnv({ fixture: fixturePath(p.id, fixture), dump: dumpFile }),
      },
      session: { PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
    },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(`launch refused: ${launched.reason}`);
  open.push({ adapter, handle: launched.handle });
  const dump = () => {
    const d = readDump(dumpFile);
    if (!d) throw new Error('replay CLI never started');
    return d;
  };
  return { adapter, handle: launched.handle, tap: new EventTap(adapter, launched.handle), dump };
}

const ended = (e: AdapterEvent) => e.type === 'turn.ended';

/** Смерть прежнего ядра для сеанса: его насос дочитал вывод и закрыл канал; хост и CLI живы. */
async function coreDies(adapter: SdkAdapter, handle: SessionHandle, tap: EventTap) {
  const session = adapter.session(handle)!;
  const size = statSync(sessionFile(handle.dir, 'stdout')).size;
  const deadline = Date.now() + 10_000;
  while (session.position < size && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  session.close();
  await tap.until(() => false, 2_000).catch(() => undefined);
  return [...tap.seen];
}

async function reattach(p: Profile, handle: SessionHandle, permitServer = false) {
  const adapter = p.make();
  const got = await adapter.reattach({
    sessionId: handle.sessionId,
    dir: handle.dir,
    host: handle.host,
    spawned: handle.spawned,
    permitServer,
  });
  return { adapter, got };
}

function liveOf(got: ReattachOutcome) {
  if (got.state !== 'live') throw new Error(`not live: ${JSON.stringify(got)}`);
  return got;
}

async function take(tap: EventTap, n: number): Promise<AdapterEvent[]> {
  while (tap.seen.length < n) await tap.until(() => true, 5_000);
  return tap.seen.slice(0, n);
}

const users = (stdin: Record<string, unknown>[]) =>
  stdin.filter((l) => l.type === 'user').map((l) => l.uuid);

describe.each(PROFILES)('$id session survives the core (P89)', (p) => {
  it('the new core re-attaches the same host: history replayed exactly once, a repeated cmdId is a dup, the next send is ours', async () => {
    const first = await launch(p, 'basic');
    expect(await first.adapter.send(first.handle, 'hello one', A)).toEqual({ dup: false });
    expect(await first.tap.until(ended)).toMatchObject({ attribution: A });
    const before = await coreDies(first.adapter, first.handle, first.tap);
    const sizeAtDeath = statSync(sessionFile(first.handle.dir, 'stdout')).size;

    const { adapter, got } = await reattach(p, first.handle);
    const now = liveOf(got);
    expect(now.handle.host).toEqual(first.handle.host);
    expect(now.handle.child).toEqual(first.handle.child);
    expect(now.replayed).toBe(before.length);
    expect(now.conversationId).toBe(first.adapter.session(first.handle)!.conversationId);
    const tap = new EventTap(adapter, now.handle);
    expect(await take(tap, now.replayed)).toEqual(before);

    expect(await adapter.send(now.handle, 'hello one', A)).toEqual({ dup: true });
    expect(await adapter.send(now.handle, 'second', B)).toEqual({ dup: false });
    expect(await tap.until(ended)).toMatchObject({ attribution: B });
    expect(users(first.dump().stdin)).toEqual([A, B]);
    // Управляющий `initialize` прежнего ядра подтверждён — новый его не повторяет.
    const inits = first
      .dump()
      .stdin.filter(
        (l) => (l.request as { subtype?: string } | undefined)?.subtype === 'initialize',
      );
    expect(inits).toHaveLength(p.id === 'qwen' ? 1 : 0);
    // Хост отбросил бы повтор и сам, но его память cmdId ограничена: новое ядро не шлёт вовсе.
    const record = readFileSync(join(first.handle.dir, IO_RECORD), 'utf8');
    expect(record.split('"id":"initialize"').length - 1).toBe(p.id === 'qwen' ? 1 : 0);
    // Отправка записана с местом насоса: новое ядро шлёт B, дочитав всю историю прежнего.
    const sends = record
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { t: string; cmdId?: string; at?: number })
      .filter((l) => l.t === 'send');
    expect(sends.map((l) => l.cmdId)).toEqual([A, B]);
    expect(sends[1]!.at).toBeGreaterThanOrEqual(sizeAtDeath);
    expect(adapter.usage(now.handle).length).toBeGreaterThanOrEqual(2);
    expect(await adapter.stop(now.handle, 'soft')).toMatchObject({ how: 'exited' });
  });

  it('a send the dead core recorded but the host never got goes out once, with its cmdId, attributed', async () => {
    const first = await launch(p, 'basic');
    await first.adapter.send(first.handle, 'hello one', A);
    await first.tap.until(ended);
    await coreDies(first.adapter, first.handle, first.tap);
    // Смерть между записью отправки и записью в хост: строка есть, ack нет.
    const at = statSync(sessionFile(first.handle.dir, 'stdout')).size;
    appendFileSync(
      join(first.handle.dir, IO_RECORD),
      `${JSON.stringify({ t: 'send', cmdId: B, uuid: B, at, data: sdkUserLine('second', B) })}\n`,
    );

    const { adapter, got } = await reattach(p, first.handle);
    const now = liveOf(got);
    const tap = new EventTap(adapter, now.handle);
    await take(tap, now.replayed);
    expect(await tap.until(ended)).toMatchObject({ attribution: B });
    expect(await adapter.send(now.handle, 'second', B)).toEqual({ dup: true });
    expect(users(first.dump().stdin)).toEqual([A, B]);
    await adapter.stop(now.handle, 'soft');
  });

  it('outcomes other than live keep their meaning: exited, lost, a foreign host identity is unknown', async () => {
    const first = await launch(p, 'basic');
    await first.adapter.send(first.handle, 'hello one', A);
    await first.tap.until(ended);
    const other = await reattach(p, {
      ...first.handle,
      host: { ...first.handle.host, start: 'x' },
    });
    expect(other.got).toMatchObject({
      state: 'unknown',
      reason: 'host identity differs from the journal',
    });
    await first.adapter.stop(first.handle, 'soft');
    expect((await reattach(p, first.handle)).got.state).toBe('exited');
    const empty = join(live.root, `empty-${p.id}`);
    mkdirSync(empty, { recursive: true });
    expect((await reattach(p, { ...first.handle, dir: empty })).got).toMatchObject({
      state: 'lost',
      reason: 'no host record',
    });
  });
});

describe('in-band permission question across a core restart (qwen)', () => {
  const p = PROFILES[1]!;
  const permit = {
    permitServer: { name: 'agentdeck-permit', tool: 'approve' },
    mcpServers: { 'agentdeck-permit': { command: process.execPath, args: ['x.mjs'] } },
  };

  it('a question the dead core never answered is asked again and answered once', async () => {
    const first = await launch(p, 'permit-core-allow', permit);
    await first.adapter.send(first.handle, 'RUN_SHELL now', A);
    const ask = await first.tap.until((e) => e.type === 'permit.request');
    if (ask.type !== 'permit.request') throw new Error('unreachable');
    await coreDies(first.adapter, first.handle, first.tap);

    const { adapter, got } = await reattach(p, first.handle, true);
    const now = liveOf(got);
    const tap = new EventTap(adapter, now.handle);
    const again = await tap.until((e) => e.type === 'permit.request');
    expect(again).toMatchObject({ requestId: ask.requestId });
    const read = adapter.permitCodec.read(ask.raw);
    await adapter.answerPermit!(
      now.handle,
      ask.requestId,
      adapter.permitCodec.render({ allow: true, input: read!.call.input }),
    );
    expect(await tap.until(ended)).toMatchObject({ attribution: A });
    const replies = first.dump().stdin.filter((l) => l.type === 'control_response');
    expect(replies).toHaveLength(1);
    await adapter.stop(now.handle, 'soft');
  });

  it('a question the dead core answered is not asked again', async () => {
    const first = await launch(p, 'permit-core-allow', permit);
    await first.adapter.send(first.handle, 'RUN_SHELL now', A);
    const ask = await first.tap.until((e) => e.type === 'permit.request');
    if (ask.type !== 'permit.request') throw new Error('unreachable');
    const read = first.adapter.permitCodec.read(ask.raw);
    await first.adapter.answerPermit!(
      first.handle,
      ask.requestId,
      first.adapter.permitCodec.render({ allow: true, input: read!.call.input }),
    );
    await first.tap.until(ended);
    await coreDies(first.adapter, first.handle, first.tap);

    const { adapter, got } = await reattach(p, first.handle, true);
    const now = liveOf(got);
    const tap = new EventTap(adapter, now.handle);
    const history = await take(tap, now.replayed);
    expect(history.some((e) => e.type === 'turn.ended')).toBe(true);
    // Вопрос — не строка истории, а действие насоса: ответ прежнего ядра записан, вопроса нет.
    await expect(tap.until((e) => e.type === 'permit.request', 1_500)).rejects.toThrow(/timeout/);
    expect(first.dump().stdin.filter((l) => l.type === 'control_response')).toHaveLength(1);
    await adapter.stop(now.handle, 'soft');
  });
});
