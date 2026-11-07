import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../claude/claude.ts';
import { createAdapterRegistry } from '../index.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../qwen/qwen.ts';
import { EventTap, liveRoot, liveSpec } from './__fixtures__/live.ts';
import { fixturePath, installReplay, replayEnv } from './__fixtures__/replay.ts';
import { s8Turns } from './__fixtures__/s8-scenario.ts';

/**
 * `backgroundFacts` (этап 11, P121 в части истории агентов): переходник объявляет его только с
 * доказанным случаем здесь — ЗАПИСЬ живого CLI идёт через настоящий запуск (платформа, хост
 * сессии, насос, нормализатор, конец сеанса), и `agent.*` / `bg.*` выходят такими, какими их
 * видел живой CLI. Объявивший без случая переходник — красный: его дерево агентов не доказано.
 */

type Fact = Extract<
  AdapterEvent,
  { type: 'agent.spawned' | 'agent.ended' | 'bg.started' | 'bg.ended' }
>;

interface Case {
  cli: 'claude' | 'qwen';
  fixture: string;
  messages: string[];
  /** Ряд фактов: вид и опознавательные поля, по порядку потока. */
  facts: [Fact['type'], Record<string, unknown>][];
}

const CASES: Readonly<Record<string, Case>> = {
  claude: {
    cli: 'claude',
    fixture: 'agents-probe',
    messages: ['PROBE_AGENTS run the probe'],
    facts: [
      ['agent.spawned', { toolUseId: 'toolu_stub_1_0', model: 'sonnet', kind: 'subagent' }],
      ['agent.ended', { toolUseId: 'toolu_stub_1_0', how: 'completed' }],
      [
        'bg.started',
        { itemId: 'b1zqng9u1', kind: 'background-shell', toolUseId: 'toolu_stub_2_0' },
      ],
      ['bg.ended', { itemId: 'b1zqng9u1', how: 'exit', exitCode: 0 }],
    ],
  },
  qwen: {
    cli: 'qwen',
    fixture: 's8-probe',
    messages: s8Turns().map((t) => t.message),
    facts: [
      ['bg.started', { itemId: 'bg_e43074da', pid: 69568, toolUseId: 'call_stub_9_0' }],
      ['agent.spawned', { toolUseId: 'call_stub_11_0', background: true, kind: 'subagent' }],
      ['agent.ended', { toolUseId: 'call_stub_11_0', how: 'completed' }],
    ],
  },
};

const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', model: 'stub-model', key: 'stub-key' };
const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];

afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree').catch(() => undefined);
});

const isFact = (e: AdapterEvent): e is Fact =>
  e.type === 'agent.spawned' ||
  e.type === 'agent.ended' ||
  e.type === 'bg.started' ||
  e.type === 'bg.ended';

async function replay(c: Case): Promise<Fact[]> {
  const live = liveRoot(`bgfacts-${c.cli}-`);
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  installReplay(
    bin,
    c.cli === 'claude' ? claudeRunFacts.binary.command : qwenRunFacts.binary.command,
  );
  const adapter =
    c.cli === 'claude'
      ? createClaudeAdapter({ pollMs: 20, unhookedForTests: true })
      : createQwenAdapter({ pollMs: 20, unhookedForTests: true });
  const base = liveSpec(live);
  const spec = liveSpec(live, {
    endpoint:
      c.cli === 'claude'
        ? {
            channel: CLAUDE_CHANNELS[0]!,
            endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' as const },
          }
        : {
            channel: QWEN_CHANNELS.find((ch) => ch.dialect === 'openai-chat')!,
            endpoint: { ...ENDPOINT, dialect: 'openai-chat' as const },
          },
    env: {
      pin: {
        ...base.env.pin,
        ...replayEnv({
          fixture: fixturePath(c.cli, c.fixture),
          dump: join(live.root, 'dump.json'),
        }),
      },
      session: { PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
    },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(`launch refused: ${launched.reason}`);
  open.push({ adapter, handle: launched.handle });
  const tap = new EventTap(adapter, launched.handle);
  for (const message of c.messages)
    await adapter.send(launched.handle, message, crypto.randomUUID());
  // Ждём последний ход записи, не число фактов: недостающий факт — провал сверки, не зависание.
  const turns =
    readFileSync(fixturePath(c.cli, c.fixture), 'utf8').split('"type":"result"').length - 1;
  // Итог хода ядра — `turn.ended`, итог хода, начатого CLI (пробуждение фоном), — `turn.cli-initiated`.
  const ended = () =>
    tap.seen.filter((e) => e.type === 'turn.ended' || e.type === 'turn.cli-initiated').length >=
    turns;
  if (!ended()) await tap.until(ended, 60_000);
  await adapter.stop(launched.handle, 'soft');
  return tap.seen.filter(isFact);
}

describe('adapter conformance — background facts (stage 11, P121)', () => {
  it('every adapter that declares backgroundFacts has a recorded replay case, and every case adapter declares it', () => {
    const declared = createAdapterRegistry()
      .all()
      .filter((a) => a.backgroundFacts)
      .map((a) => a.id)
      .sort();
    expect(declared.filter((id) => !Object.hasOwn(CASES, id))).toEqual([]);
    expect(Object.keys(CASES).sort()).toEqual(declared);
  });

  for (const [id, c] of Object.entries(CASES)) {
    it(`${id}: the recording through the real launch gives the agent and background facts the live CLI showed`, async () => {
      const facts = await replay(c);
      expect(facts.map((f) => f.type)).toEqual(c.facts.map(([type]) => type));
      c.facts.forEach(([, fields], i) => expect(facts[i]).toMatchObject(fields));
    }, 120_000);
  }
});
