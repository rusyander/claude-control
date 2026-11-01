import { describe, expect, it } from 'vitest';
import type { AdapterEvent } from '../adapter.types.ts';
import { mapClaudePermission } from '../claude/permission.ts';
import { readClaudeWindow } from '../claude/window.ts';
import { mapQwenPermission } from '../qwen/permission.ts';
import { SdkNormaliser, type SdkRule } from './normalise.ts';

/**
 * Точность учёта хода (план s5 зона L, P43): часовая доля кэша, остаток по итогу `result`,
 * подагент; строка окна — только у CLI с объявленным событием (Qwen — `unknown`, G13).
 */

const NO_ECHO: SdkRule = { echo: false, mapPermission: mapQwenPermission };
const CLAUDE: SdkRule = {
  echo: false,
  mapPermission: mapClaudePermission,
  readWindow: readClaudeWindow,
};

const feed = (n: SdkNormaliser, lines: object[]): AdapterEvent[] =>
  lines.flatMap((o) => n.push(JSON.stringify(o)));
const usageOf = (events: AdapterEvent[]) => events.filter((e) => e.type === 'usage');
const start = (id: string, usage: object, extra: object = {}) => ({
  type: 'stream_event',
  event: { type: 'message_start', message: { id, model: 'stub-model', usage } },
  ...extra,
});
const delta = (id: string, usage: object, extra: object = {}) => ({
  type: 'stream_event',
  api_message_id: id,
  event: { type: 'message_delta', usage },
  ...extra,
});
const stop = (id: string) => ({
  type: 'stream_event',
  api_message_id: id,
  event: { type: 'message_stop' },
});
const result = (usage: object | undefined, over: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
  result: 'done',
  uuid: 'r-1',
  ...(usage ? { usage } : {}),
  modelUsage: { 'stub-model': {} },
  ...over,
});

describe('sdk normaliser: usage fidelity (zone L, P43)', () => {
  it('the 1h cache share comes from message_start and rides every usage of the message', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, [
      start('m1', {
        input_tokens: 3,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_1h_input_tokens: 80, ephemeral_5m_input_tokens: 20 },
      }),
      delta('m1', { output_tokens: 9 }),
      stop('m1'),
      result(undefined),
    ]);
    expect(usageOf(events)).toEqual([
      {
        type: 'usage',
        messageId: 'm1',
        input: 3,
        cacheRead: 0,
        cacheWrite: 100,
        cacheWrite1h: 80,
        output: 9,
        model: 'stub-model',
      },
    ]);
  });

  it('the result total above the turn messages adds ONE remainder row; equal or below adds none', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    n.expect('c2', 'u2');
    const first = feed(n, [
      start('m1', { input_tokens: 10, cache_read_input_tokens: 5 }),
      delta('m1', { output_tokens: 4 }),
      stop('m1'),
      result({
        input_tokens: 25,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 6,
        cache_creation: { ephemeral_1h_input_tokens: 6 },
        output_tokens: 7,
      }),
    ]);
    expect(usageOf(first)).toEqual([
      expect.objectContaining({ messageId: 'm1', input: 10, output: 4 }),
      {
        type: 'usage',
        messageId: 'result:r-1',
        input: 15,
        cacheRead: 0,
        cacheWrite: 6,
        cacheWrite1h: 6,
        output: 3,
        model: 'stub-model',
        remainder: true,
      },
    ]);
    // Второй ход: итог ЭТОГО хода (не накопленный) равен его сообщениям — остатка нет.
    const second = feed(n, [
      start('m2', { input_tokens: 2 }),
      delta('m2', { output_tokens: 1 }),
      stop('m2'),
      result({ input_tokens: 2, output_tokens: 1 }, { uuid: 'r-2' }),
    ]);
    expect(usageOf(second).map((e) => e.type === 'usage' && e.messageId)).toEqual(['m2']);
    // Итог меньше насчитанного: отнимать нечем — молчим.
    n.expect('c3', 'u3');
    const third = feed(n, [
      start('m3', { input_tokens: 9 }),
      stop('m3'),
      result({ input_tokens: 1 }, { uuid: 'r-3' }),
    ]);
    expect(usageOf(third).map((e) => e.type === 'usage' && e.messageId)).toEqual(['m3']);
  });

  it('a subagent message (parent_tool_use_id) is marked subagent; a main message is not', () => {
    const n = new SdkNormaliser(NO_ECHO);
    n.expect('c1', 'u1');
    const events = feed(n, [
      start('m1', { input_tokens: 4 }),
      stop('m1'),
      {
        type: 'assistant',
        parent_tool_use_id: 'toolu_task',
        message: { id: 'sub1', model: 'sub-model', usage: { input_tokens: 6, output_tokens: 2 } },
      },
      result(undefined),
    ]);
    const rows = usageOf(events);
    expect(rows).toEqual([
      expect.objectContaining({ messageId: 'm1', input: 4 }),
      expect.objectContaining({ messageId: 'sub1', input: 6, model: 'sub-model', subagent: true }),
    ]);
    expect(rows[0]).not.toHaveProperty('subagent');
  });

  it('G13 a CLI without a declared window event yields no window event; Claude yields one', () => {
    const raw = {
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', resetsAt: 100, rateLimitType: 'five_hour' },
    };
    expect(new SdkNormaliser(NO_ECHO).push(JSON.stringify(raw))).toEqual([]);
    expect(new SdkNormaliser(CLAUDE).push(JSON.stringify(raw))).toEqual([
      {
        type: 'window',
        limitKind: 'window',
        usedPct: null,
        resetAt: 100_000,
        warning: false,
        refusal: true,
        window: 'five_hour',
      },
    ]);
  });
});
