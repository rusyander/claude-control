import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import { translate } from './ChatRunner.ts';
import { createWatchState, reduce } from '../token-ledger/watch/reduce.ts';
import { evaluate } from '../token-ledger/watch/rules.ts';
import { streamWatchEvents } from '../token-ledger/watch/stream-events.ts';
import type { WatchEvent } from '../token-ledger/watch/watch.types.ts';

/**
 * Итог вызова в живом потоке → сторож (R15 упор в срок, R18 отказ стража).
 * Строки `user` — записанные с настоящего CLI 2.1.286 в режиме `-p --output-format
 * stream-json` (22.10.2026; id сессий и вывод обезличены): у строки верхнее поле
 * `tool_use_result` (объект при успехе, «Error: …» при ошибке), у блока
 * `is_error`, у отказа хука — `tool_result_meta[].non_execution_kind`. Путь
 * настоящий: `translate` → `streamWatchEvents` → свёртка → правила.
 */

type Raw = Parameters<typeof translate>[0];
const raw = (value: unknown): Raw => value as Raw;

/** Таймаут `-p`: CLI убивает команду (код 143), в фон не уводит. */
const KILLED_LINE = {
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        content: 'Exit code 143\nCommand timed out after 3s',
        is_error: true,
        tool_use_id: 'toolu_k',
      },
    ],
  },
  parent_tool_use_id: null,
  session_id: 's-1',
  tool_use_result: 'Error: Exit code 143\nCommand timed out after 3s',
};

const OK_LINE = {
  type: 'user',
  message: {
    role: 'user',
    content: [{ tool_use_id: 'toolu_ok', type: 'tool_result', content: 'user', is_error: false }],
  },
  parent_tool_use_id: null,
  session_id: 's-1',
  tool_use_result: { stdout: 'user', stderr: '', interrupted: false, isImage: false },
};

const DENIED_TEXT =
  "PreToolUse:Bash hook error: [ctx-guard] cmd-duration: this command took ~4 s here but the call's timeout is 3 s";
const denialLine = (id: string) => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', content: DENIED_TEXT, is_error: true, tool_use_id: id }],
  },
  parent_tool_use_id: null,
  session_id: 's-2',
  tool_use_result: `Error: ${DENIED_TEXT}`,
  tool_result_meta: [{ id, non_execution_kind: 'permission-rule' }],
});

const assistantBash = (id: string, input: Record<string, unknown>) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] },
  parent_tool_use_id: null,
});

/** Строки потока со временем → события сторожа, как у сторожа: `streamWatchEvents(translate(...))`. */
function watchEvents(lines: Array<[number, unknown]>): WatchEvent[] {
  return lines.flatMap(([t, line]) =>
    translate(raw(line)).flatMap((event) => streamWatchEvents(event, t, 'work')),
  );
}

function rulesAt(list: readonly WatchEvent[], now: number): string[] {
  const ctx = { settings: GROUP_WATCH_DEFAULTS };
  const state = createWatchState(0);
  for (const event of list) reduce(state, event, ctx);
  const node = { chatId: 'c', groupIndex: 0, running: true, paused: false };
  return evaluate(state, node, ctx, now).map((hit) => hit.rule);
}

describe('translate — итог вызова для сторожа (CLI 2.1.286)', () => {
  it('убитый по сроку вызов несёт свой срок; успешный — ничего лишнего', () => {
    expect(translate(raw(KILLED_LINE))).toEqual([
      { kind: 'toolResult', toolUseId: 'toolu_k', chars: 40, timedOutMs: 3000 },
    ]);
    expect(translate(raw(OK_LINE))).toEqual([
      { kind: 'toolResult', toolUseId: 'toolu_ok', chars: 4 },
    ]);
  });

  it('отказ хука несёт имя стража; род из `tool_result_meta` — запасной', () => {
    expect(translate(raw(denialLine('toolu_d')))).toEqual([
      {
        kind: 'toolResult',
        toolUseId: 'toolu_d',
        chars: DENIED_TEXT.length,
        denied: 'cmd-duration',
      },
    ]);
    const bare = {
      ...denialLine('toolu_e'),
      message: {
        content: [
          { type: 'tool_result', content: 'blocked', is_error: true, tool_use_id: 'toolu_e' },
        ],
      },
    };
    expect(translate(raw(bare))).toEqual([
      { kind: 'toolResult', toolUseId: 'toolu_e', chars: 7, denied: 'permission-rule' },
    ]);
  });

  it('старый увод в фон: `timedOutAfterMs` из `tool_use_result` одного результата', () => {
    const line = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_bg',
            content:
              'Command did not complete within its 600s timeout and was moved to the background',
          },
        ],
      },
      tool_use_result: { timedOutAfterMs: 600_000, interrupted: false },
    };
    expect(translate(raw(line))).toEqual([
      { kind: 'toolResult', toolUseId: 'toolu_bg', chars: 80, timedOutMs: 600_000 },
    ]);
  });

  it('вывод команды с тем же текстом — не упор и не отказ: CLI пишет их в начале ответа', () => {
    const line = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_cat',
            content: 'log:\nCommand timed out after 10m\nPreToolUse:Bash hook error: x',
            is_error: false,
          },
        ],
      },
    };
    expect(translate(raw(line))).toEqual([
      { kind: 'toolResult', toolUseId: 'toolu_cat', chars: 62 },
    ]);
  });

  it('два результата в строке: итог строки ни к одному, род отказа — только к своему id', () => {
    const block = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'out' });
    const line = {
      type: 'user',
      message: {
        content: [
          { ...block('toolu_a'), is_error: true },
          { ...block('toolu_b'), is_error: true },
        ],
      },
      // Итог строки — чей из двух, не сказано: срок не приписывается никому.
      tool_use_result: { timedOutAfterMs: 600_000 },
      tool_result_meta: [{ id: 'toolu_b', non_execution_kind: 'permission-rule' }],
    };
    // Ошибка без отказа — род и голова для R24/R29/R30; отбитый вызов — только отказ.
    expect(translate(raw(line))).toEqual([
      {
        kind: 'toolResult',
        toolUseId: 'toolu_a',
        chars: 3,
        isError: true,
        errorKind: 'other',
        errorHead: 'out',
      },
      { kind: 'toolResult', toolUseId: 'toolu_b', chars: 3, denied: 'permission-rule' },
    ]);
  });

  it('блок `null` или содержимое не массивом — пропуск, а не исключение на живом пути', () => {
    expect(translate(raw({ type: 'assistant', message: { content: [null] } }))).toEqual([]);
    expect(translate(raw({ type: 'assistant', message: { content: 'text' } }))).toEqual([]);
    const user = {
      type: 'user',
      message: { content: [null, { type: 'tool_result', tool_use_id: 'toolu_n', content: 'x' }] },
    };
    expect(translate(raw(user))).toEqual([{ kind: 'toolResult', toolUseId: 'toolu_n', chars: 1 }]);
  });
});

describe('поток → сторож: R15 и R18 живым путём', () => {
  it('вызов `pnpm test` убит по сроку 10 мин — R15; трёхсекундная проба — нет', () => {
    const killed = (id: string, spec: string) => ({
      ...KILLED_LINE,
      message: {
        content: [
          {
            type: 'tool_result',
            content: `Exit code 143\nCommand timed out after ${spec}`,
            is_error: true,
            tool_use_id: id,
          },
        ],
      },
    });
    const long = watchEvents([
      [0, assistantBash('t1', { command: 'pnpm test', timeout: 600_000 })],
      [600_000, killed('t1', '10m')],
    ]);
    expect(rulesAt(long, 600_000)).toContain('R15');
    const probe = watchEvents([
      [0, assistantBash('t2', { command: 'sleep 9', timeout: 3000 })],
      [3000, killed('t2', '3s')],
    ]);
    expect(rulesAt(probe, 3000)).not.toContain('R15');
  });

  it('пять отказов стража за пять минут — R18', () => {
    const lines: Array<[number, unknown]> = [];
    for (let i = 0; i < 5; i++) {
      lines.push([i * 60_000, assistantBash(`d${i}`, { command: 'sleep 4', timeout: 3000 })]);
      lines.push([i * 60_000 + 100, denialLine(`d${i}`)]);
    }
    const list = watchEvents(lines);
    expect(rulesAt(list, 4 * 60_000 + 100)).toContain('R18');
    expect(rulesAt(list.slice(0, 8), 3 * 60_000 + 100)).not.toContain('R18');
  });
});
