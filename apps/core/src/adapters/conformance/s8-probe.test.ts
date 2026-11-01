import { mkdirSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { qwenRunFacts } from '@agentdeck/providers/qwen';
import type { AdapterEvent, CliAdapter, SessionHandle } from '../adapter.types.ts';
import { CLAUDE_CHANNELS, createClaudeAdapter } from '../claude/claude.ts';
import { createQwenAdapter, QWEN_CHANNELS } from '../qwen/qwen.ts';
import { EventTap, liveRoot, liveSpec } from './__fixtures__/live.ts';
import { fixturePath, installReplay, replayEnv } from './__fixtures__/replay.ts';
import { s8Turns } from './__fixtures__/s8-scenario.ts';

/**
 * Проба этапа 8 проигрышем (P121 в части наблюдателя): ЗАПИСЬ живого Claude Code 2.1.310 и Qwen
 * Code 0.24.3 (`record-s8.ts`) идёт через настоящий запуск переходника (платформа, хост сессии,
 * насос, нормализатор) — исход вызова, диапазон чтения и родитель подагента читаются так же, как
 * у живого CLI. Факты и строки-доказательства — `.agent/tmp/core-s8-measure.agent.md` §Probe.
 */

type Result = Extract<AdapterEvent, { type: 'tool.result' }>;
type Requested = Extract<AdapterEvent, { type: 'tool.requested' }>;

const ENDPOINT = { baseUrl: 'http://127.0.0.1:9', model: 'stub-model', key: 'stub-key' };
const open: { adapter: CliAdapter; handle: SessionHandle }[] = [];

afterAll(async () => {
  for (const { adapter, handle } of open) await adapter.stop(handle, 'tree').catch(() => undefined);
});

/** Проигрыш всей записи: каждое сообщение сценария, затем ожидание названных вызовов. */
async function replay(cli: 'claude' | 'qwen', waitFor: string[]): Promise<AdapterEvent[]> {
  const live = liveRoot(`s8-replay-${cli}-`);
  const bin = join(live.root, 'bin');
  mkdirSync(bin, { recursive: true });
  const command = cli === 'claude' ? claudeRunFacts.binary.command : qwenRunFacts.binary.command;
  installReplay(bin, command);
  // Подставной CLI хуков не исполняет: сеанс без хука ядра — только с флагом тестов (F-10).
  const adapter =
    cli === 'claude'
      ? createClaudeAdapter({ pollMs: 20, unhookedForTests: true })
      : createQwenAdapter({ pollMs: 20, unhookedForTests: true });
  const base = liveSpec(live);
  const endpoint =
    cli === 'claude'
      ? {
          channel: CLAUDE_CHANNELS[0]!,
          endpoint: { ...ENDPOINT, dialect: 'anthropic-messages' as const },
        }
      : {
          channel: QWEN_CHANNELS.find((c) => c.dialect === 'openai-chat')!,
          endpoint: { ...ENDPOINT, dialect: 'openai-chat' as const },
        };
  const spec = liveSpec(live, {
    endpoint,
    env: {
      pin: {
        ...base.env.pin,
        ...replayEnv({ fixture: fixturePath(cli, 's8-probe'), dump: join(live.root, 'dump.json') }),
      },
      session: { PATH: [bin, dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) },
    },
  });
  const launched = await adapter.launch(spec);
  if (!launched.ok) throw new Error(`launch refused: ${launched.reason}`);
  open.push({ adapter, handle: launched.handle });
  const tap = new EventTap(adapter, launched.handle);
  for (const turn of s8Turns())
    await adapter.send(launched.handle, turn.message, crypto.randomUUID());
  for (const id of waitFor)
    await tap.until((e) => e.type === 'tool.result' && e.toolUseId === id, 60_000);
  await adapter.stop(launched.handle, 'soft');
  return tap.seen;
}

const resultOf = (seen: AdapterEvent[], id: string): Result => {
  const found = seen.find((e): e is Result => e.type === 'tool.result' && e.toolUseId === id);
  if (!found) throw new Error(`no tool.result ${id}`);
  return found;
};
const requestOf = (seen: AdapterEvent[], id: string): Requested => {
  const found = seen.find((e): e is Requested => e.type === 'tool.requested' && e.toolUseId === id);
  if (!found) throw new Error(`no tool.requested ${id}`);
  return found;
};
/** Текст блока результата в записи — размер считается от него. */
const recordedContent = (cli: string, id: string): string => {
  for (const line of readFileSync(fixturePath(cli, 's8-probe'), 'utf8').split('\n')) {
    if (!line.includes(`"tool_use_id":"${id}"`) || !line.includes('"tool_result"')) continue;
    const o = JSON.parse(line) as {
      message: { content: { tool_use_id: string; content: unknown }[] };
    };
    const block = o.message.content.find((b) => b.tool_use_id === id)!;
    return typeof block.content === 'string'
      ? block.content
      : (block.content as { text: string }[]).map((p) => p.text).join('\n');
  }
  throw new Error(`no recorded result ${id}`);
};

describe('stage 8 probe replay — claude 2.1.310', () => {
  it('outcome: no structured exit code (null), CLI error text as errorText, bytes of the model payload; sleep block, ranged read and subagent parent from the stream', async () => {
    const seen = await replay('claude', ['toolu_stub_1_0', 'toolu_stub_7_0', 'toolu_stub_18_0']);
    // Упавшая команда: код выхода только текстом CLI — структурного поля нет (F18).
    expect(resultOf(seen, 'toolu_stub_1_0')).toMatchObject({
      isError: true,
      outcome: { exitCode: null, errorText: 'Exit code 3\nboom-to-stderr' },
    });
    // Отдельный `sleep 25` CLI отбивает сам, до хука и права.
    expect(resultOf(seen, 'toolu_stub_3_0').outcome?.errorText).toMatch(
      /^<tool_use_error>Blocked: standalone sleep 25\./,
    );
    // Сцепленный `sleep 21 && …` исполняется: успех без текста ошибки.
    expect(resultOf(seen, 'toolu_stub_4_0')).toMatchObject({
      isError: false,
      outcome: { exitCode: null, errorText: null, bytes: 5 },
    });
    // Размер чтения — байты того, что получила модель.
    const ranged = resultOf(seen, 'toolu_stub_6_0');
    expect(ranged.outcome?.bytes).toBe(
      Buffer.byteLength(recordedContent('claude', 'toolu_stub_6_0')),
    );
    expect(ranged.outcome?.bytes).toBeGreaterThan(0);
    // Диапазон чтения: канон ядра = номер строки с единицы, как у Claude.
    const adapter = createClaudeAdapter();
    const raw = (id: string) => {
      const r = requestOf(seen, id);
      return { tool: r.name, input: r.input as Record<string, unknown> };
    };
    expect(adapter.mapPermission(raw('toolu_stub_6_0')).range).toEqual({ offset: 10, limit: 5 });
    expect(adapter.mapPermission(raw('toolu_stub_7_0')).range).toBeNull();
    // Подагент: его вызовы помечены вызовом-родителем, главные — `null`.
    expect(requestOf(seen, 'toolu_stub_14_0').parentToolUseId).toBe('toolu_stub_12_0');
    expect(requestOf(seen, 'toolu_stub_12_0').parentToolUseId).toBeNull();
    expect(requestOf(seen, 'toolu_stub_6_0').parentToolUseId).toBeNull();
  }, 120_000);
});

describe('stage 8 probe replay — qwen 0.24.3', () => {
  it('outcome: exit code null, PGID line dropped from errorText, bytes null (stream carries a display summary); 0-based offset → canonical 1-based range', async () => {
    const seen = await replay('qwen', ['call_stub_1_0', 'call_stub_7_0', 'call_stub_17_0']);
    const failed = resultOf(seen, 'call_stub_1_0');
    expect(failed).toMatchObject({ isError: true, outcome: { exitCode: null, bytes: null } });
    expect(failed.outcome?.errorText).toContain('Exit Code: 3');
    expect(failed.outcome?.errorText).not.toContain('Process Group PGID');
    // Тот же сбой ещё раз дал бы тот же текст: в нём нет pid.
    expect(failed.outcome?.errorText).not.toMatch(/\d{4,}/);
    expect(resultOf(seen, 'call_stub_3_0').outcome?.errorText).toMatch(
      /^Blocked: standalone sleep 25\./,
    );
    expect(resultOf(seen, 'call_stub_6_0').outcome).toEqual({
      exitCode: null,
      errorText: null,
      bytes: null,
    });
    const adapter = createQwenAdapter();
    const raw = (id: string) => {
      const r = requestOf(seen, id);
      return { tool: r.name, input: r.input as Record<string, unknown> };
    };
    expect(adapter.mapPermission(raw('call_stub_6_0')).range).toEqual({ offset: 11, limit: 5 });
    expect(adapter.mapPermission(raw('call_stub_7_0')).range).toBeNull();
    // Вызовы подагента Qwen в поток не попадают: видимые — главный контекст.
    expect(requestOf(seen, 'call_stub_11_0').parentToolUseId).toBeNull();
    expect(seen.filter((e) => e.type === 'tool.requested' && e.parentToolUseId !== null)).toEqual(
      [],
    );
  }, 120_000);
});
