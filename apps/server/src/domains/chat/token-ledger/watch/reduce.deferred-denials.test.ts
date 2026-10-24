import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import {
  alreadyQueuedDenial,
  deferralDenial,
  humanRefusedDenial,
  keepDraftRefusal,
} from '../../deferred-asks/deferred-asks.ts';
import { createWatchState, reduce } from './reduce.ts';
import { evaluate } from './rules.ts';
import { createTranscriptReader } from './transcript-events.ts';
import type { RuleHit, WatchNode } from './watch.types.ts';

/**
 * R18 и отказы панели D-n (холодное ревью 23.10, D-L08): строки транскрипта с
 * НАСТОЯЩИМИ текстами отказов (`deferred-asks/texts.ts`) → читатель → свёртка →
 * правила. Отложить вызов человеку — законное ожидание: агент сделал ровно то,
 * что велит отказ. Стена — повтор того же вызова после «уже стоит» или «человек
 * отказал»; отказы панели с известным ответом (`panel-refused`) — тоже стена.
 */

const BASE = Date.parse('2026-10-23T10:00:00.000Z');
const iso = (second: number) => new Date(BASE + second * 1000).toISOString();

/** Вызов Bash и его ответ-отказ — две строки транскрипта, как пишет CLI. */
function denied(n: number, command: string, text: string): unknown[] {
  const id = `toolu_${n}`;
  return [
    {
      type: 'assistant',
      timestamp: iso(n * 20),
      message: {
        id: `msg_${n}`,
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
        usage: { input_tokens: 2, cache_read_input_tokens: 50_000, output_tokens: 40 },
      },
    },
    {
      type: 'user',
      timestamp: iso(n * 20 + 1),
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: true }],
      },
    },
  ];
}

function r18(rows: unknown[], settings: Partial<GroupWatch> = {}): RuleHit | undefined {
  const ctx = {
    settings: { ...GROUP_WATCH_DEFAULTS, denialRepeats: 5, denialMinutes: 15, ...settings },
  };
  const read = createTranscriptReader();
  const events = rows.flatMap((row) => read(row));
  const state = createWatchState(events[0]?.t ?? 0);
  for (const event of events) reduce(state, event, ctx);
  const node: WatchNode = { chatId: 'c1', groupIndex: 0, running: true, paused: false };
  return evaluate(state, node, ctx, events.at(-1)?.t ?? 0).find((hit) => hit.rule === 'R18');
}

const publish = (tag: number) => `npm publish --access public --tag t${tag}`;

describe('R18 и отложенные человеку вызовы (D-n)', () => {
  it('пять разных вызовов отложены D-1…D-5 за один ход — законное ожидание, R18 молчит', () => {
    const rows = [1, 2, 3, 4, 5].flatMap((n) =>
      denied(n, publish(n), deferralDenial(`D-${n}`, 'publishing needs the human')),
    );
    expect(r18(rows)).toBeUndefined();
    // Не порог: отложенный впервые вызов не отказ вовсе — и при пороге 1 тишина.
    expect(r18(rows, { denialRepeats: 1 })).toBeUndefined();
  });

  it('длинные команды с общим началом длиннее строки сигнала — разные вызовы, не повтор', () => {
    // Строка сигнала режет команду на 200 знаках: по ней пять разных публикаций
    // слились бы в одну и четыре «повтора» ушли бы в R18. Ключ — отпечаток всей команды.
    const head = `npm publish --access public --registry https://registry.example.com/${'a'.repeat(220)}`;
    const rows = [1, 2, 3, 4, 5].flatMap((n) =>
      denied(n, `${head} --tag t${n}`, deferralDenial(`D-${n}`, 'publishing needs the human')),
    );
    expect(r18(rows, { denialRepeats: 1 })).toBeUndefined();
  });

  it('тот же вызов снова после «уже стоит как D-1» — стена: пять повторов поднимают R18', () => {
    const rows = [
      ...denied(1, publish(1), deferralDenial('D-1', 'publishing needs the human')),
      ...[2, 3, 4, 5, 6].flatMap((n) => denied(n, publish(1), alreadyQueuedDenial('D-1'))),
    ];
    expect(r18(rows)).toMatchObject({
      numbers: { denials: 5 },
      params: { guard: 'deferred' },
    });
    // Четыре повтора — ниже порога 5: сама первая постановка в счёт не идёт.
    expect(r18(rows.slice(0, -2))).toBeUndefined();
  });

  it('после 25 разных D-n стена на самом первом вызове ловится на пятом повторе, не на шестом (RF-DL-14)', () => {
    const rows = [
      ...Array.from({ length: 25 }, (_, i) => i + 1).flatMap((n) =>
        denied(n, publish(n), deferralDenial(`D-${n}`, 'publishing needs the human')),
      ),
      ...[26, 27, 28, 29, 30].flatMap((n) => denied(n, publish(1), alreadyQueuedDenial('D-1'))),
    ];
    expect(r18(rows)).toMatchObject({ numbers: { denials: 5 }, params: { guard: 'deferred' } });
  });

  it('повторы после отказа человека — стена', () => {
    const rows = [
      ...denied(1, publish(1), deferralDenial('D-1', 'publishing needs the human')),
      ...[2, 3, 4, 5, 6].flatMap((n) => denied(n, publish(1), humanRefusedDenial('D-1', 'no'))),
    ];
    expect(r18(rows)).toMatchObject({ numbers: { denials: 5 }, params: { guard: 'deferred' } });
  });

  it('отказ панели с известным ответом (panel-refused) считается, как отказ стража', () => {
    const rows = [1, 2, 3, 4, 5].flatMap((n) =>
      denied(n, `gh pr ready ${n}`, keepDraftRefusal(['D-1'])),
    );
    expect(r18(rows)).toMatchObject({
      numbers: { denials: 5 },
      params: { guard: 'panel-refused' },
    });
  });
});
