import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { codexWatchEvents, qwenWatchEvents } from '../foreign/foreign-events.ts';
import type { ForeignRowReader } from '../foreign/foreign.types.ts';
import { GroupWatcher } from './group-watcher.ts';
import type { WatchEvent } from './watch.types.ts';

/**
 * P-35: сторож групп чужого CLI видит отказы. Отбитый вызов в переписке Codex и Qwen Code
 * становится `toolResult.denied`, как у Claude (`toolOutcome`), — и правила R18 (стена
 * отказов) и R25 (обход отказа) работают у этих групп, с теми же исключениями карточки
 * правила. Каждая форма отказа — запись НАСТОЯЩЕГО CLI на подменной модели (пути обезличены):
 *
 *   - `qwen-0.24-hook-deny.jsonl` — РЕАЛЬНАЯ: qwen 0.24.3 `-p --yolo`, хук `PreToolUse`
 *     отвечает отказом формы набора панели (`permissionDecision:'deny'`, «rule-card: …»);
 *   - `qwen-0.24-judge-deny.jsonl` — РЕАЛЬНАЯ: qwen 0.24.3 `serve`, просьба о разрешении
 *     получила отказ судьи команд панели (настоящий `QwenServeTurn`);
 *   - `codex-0.155-judge-deny.jsonl` — РЕАЛЬНАЯ: codex 0.155.1 `app-server`, просьба о
 *     разрешении получила `decline` судьи панели (настоящий `CodexAppServerTurn`, win32).
 *
 * Отказ хука набора у Codex живьём не снят (хук срабатывает только после одобрения в
 * `/hooks`): его форма не угадывается, и такого пути в разборе нет.
 */

const FIXTURES = join(import.meta.dirname, '..', 'foreign', '__fixtures__');
const lines = (name: string): string[] =>
  readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter(Boolean);
const QWEN_HOOK = lines('qwen-0.24-hook-deny.jsonl');
const QWEN_JUDGE = lines('qwen-0.24-judge-deny.jsonl');
const CODEX_JUDGE = lines('codex-0.155-judge-deny.jsonl');

const results = (read: ForeignRowReader, rows: readonly string[]) =>
  rows
    .flatMap((line) => read(JSON.parse(line)))
    .filter(
      (event): event is Extract<WatchEvent, { kind: 'toolResult' }> => event.kind === 'toolResult',
    );

type Row = Record<string, unknown> & { timestamp: string };
const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

/** Строка фикстуры с новым id вызова, временем и (если дана) командой. */
function retimed(line: string, ms: number, id: string, command?: string): string {
  let text = line.replaceAll('"call_1"', JSON.stringify(id));
  if (command) text = text.replaceAll('git push origin HEAD', command);
  const row = JSON.parse(text) as Row;
  row.timestamp = at(ms);
  return `${JSON.stringify(row)}\n`;
}

/** Вызов и его отказ — те самые строки настоящего CLI. */
function pickPair(rows: readonly string[], call: RegExp, result: RegExp): [string, string] {
  const first = rows.find((line) => call.test(line));
  const second = rows.find((line) => result.test(line));
  if (!first || !second) throw new Error('fixture lacks the call or its refusal');
  return [first, second];
}

const QWEN_CALL = /"functionCall":\{"id":"call_1"/;
const QWEN_RESULT = /"type":"tool_result"/;
const CODEX_CALL = /"type":"function_call",/;
const CODEX_RESULT = /"type":"function_call_output"/;

/** Исполненный вызов (успех) той же формы, что пишет CLI. */
const executed = {
  qwen: (ms: number, id: string, command: string) =>
    `${JSON.stringify({
      type: 'assistant',
      timestamp: at(ms),
      message: {
        role: 'model',
        parts: [{ functionCall: { id, name: 'run_shell_command', args: { command } } }],
      },
    })}\n${JSON.stringify({
      type: 'tool_result',
      timestamp: at(ms + 500),
      message: { role: 'user', parts: [{ functionResponse: { id, response: { output: 'ok' } } }] },
      toolCallResult: { callId: id, status: 'success', executionStatus: 'success' },
    })}\n`,
  codex: (ms: number, id: string, command: string) =>
    `${JSON.stringify({
      timestamp: at(ms),
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: command }),
        call_id: id,
      },
    })}\n${JSON.stringify({
      timestamp: at(ms + 500),
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: id,
        output: 'Chunk ID: 1\nProcess exited with code 0\nOutput:\nok\n',
      },
    })}\n`,
};

describe('сторож групп чужого CLI видит отказы (P-35)', () => {
  describe('разбор переписки: форма отказа каждого CLI', () => {
    it('qwen: отказ хука PreToolUse (реальная запись 0.24.3) — назван стражем из причины', () => {
      const list = results(qwenWatchEvents(), QWEN_HOOK);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'call_1', denied: 'rule-card' });
    });

    it('qwen: отказ судьи панели в qwen serve (реальная запись 0.24.3) — отказ права', () => {
      const list = results(qwenWatchEvents(), QWEN_JUDGE);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'call_1', denied: 'permission' });
    });

    it('codex: decline судьи панели в app-server (реальная запись 0.155.1) — отказ права', () => {
      const list = results(codexWatchEvents(), CODEX_JUDGE);
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ id: 'call_1', denied: 'permission' });
    });

    it('исполненный вызов — не отказ, даже если в его выводе те же слова', () => {
      for (const [read, name] of [
        [qwenWatchEvents(), 'qwen-0.24-two-turns.jsonl'],
        [codexWatchEvents(), 'codex-0.155-two-turns.jsonl'],
      ] as const) {
        const list = results(read, lines(name));
        expect(list.length).toBeGreaterThan(0);
        expect(list.filter((event) => event.denied)).toEqual([]);
      }
      // Вывод команды, где встретилась строка отказа, — вывод, а не отказ.
      const echoed = JSON.stringify({
        timestamp: at(0),
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'c9',
          output:
            'Chunk ID: 1\nOutput:\nexec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }\n',
        },
      });
      expect(results(codexWatchEvents(), [echoed])[0]?.denied).toBeUndefined();
      // Ошибка исполнения у Qwen (вызов шёл) — не отказ.
      const failed = QWEN_JUDGE.find((line) => QWEN_RESULT.test(line))!
        .replace('"status":"cancelled"', '"status":"error"')
        .replace('"executionStatus":"not_started"', '"executionStatus":"failed"');
      expect(results(qwenWatchEvents(), [failed])[0]?.denied).toBeUndefined();
    });
  });

  describe('правила сторожа над перепиской CLI', () => {
    let dir: string;
    let file: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'gw-foreign-deny-'));
      file = join(dir, 'session.jsonl');
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    function watch(provider: 'qwen' | 'codex') {
      let now = T0;
      const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS };
      const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
      const chat = `${provider}:child`;
      const watcher = new GroupWatcher({
        settings: () => settings,
        resolve: (chatId) =>
          chatId === chat
            ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work', cwd: dir }
            : undefined,
        group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
        save: () => {},
        node: () => ({ running: true, paused: false }),
        transcript: (_id, hint) => (hint?.provider === provider ? file : undefined),
        subagentDir: () => {
          throw new Error('subagentDir must not be asked for a foreign session');
        },
        now: () => now,
        makeId: () => 'id',
        plans: () => ({ parent: { groups: [group] } }),
      });
      watcher.onFeed(chat, { kind: 'start', sessionId: chat, cwd: dir, detached: true, provider });
      return {
        /** Переписка целиком, тик сторожа через минуту после последней строки. */
        run: (text: string, lastMs: number) => {
          writeFileSync(file, text);
          now = T0 + lastMs + MIN;
          watcher.tick();
          return (group.watch?.signals ?? []).filter((signal) => !signal.clearedAt);
        },
      };
    }

    const start = {
      qwen: `${JSON.stringify({ type: 'user', provenance: 'real_user', timestamp: at(0), message: { role: 'user', parts: [{ text: 'go' }] } })}\n`,
      codex: `${JSON.stringify({ timestamp: at(0), type: 'event_msg', payload: { type: 'task_started' } })}\n`,
    };

    /** `n` отказов подряд — строки настоящего CLI, свой id и время у каждого. */
    function denials(
      provider: 'qwen' | 'codex',
      rows: readonly string[],
      n: number,
      command?: (i: number) => string,
    ): { text: string; lastMs: number } {
      const [call, result] =
        provider === 'qwen'
          ? pickPair(rows, QWEN_CALL, QWEN_RESULT)
          : pickPair(rows, CODEX_CALL, CODEX_RESULT);
      let text = start[provider];
      let ms = 0;
      for (let i = 0; i < n; i += 1) {
        ms = 10_000 * (i + 1);
        const cmd = command?.(i);
        text += retimed(call, ms, `deny_${i}`, cmd) + retimed(result, ms + 1000, `deny_${i}`, cmd);
      }
      return { text, lastMs: ms + 1000 };
    }

    const DIFFERENT = (i: number) => `git push origin HEAD:refs/heads/try-${i}`;

    for (const [provider, rows] of [
      ['qwen', QWEN_JUDGE],
      ['codex', CODEX_JUDGE],
    ] as const) {
      it(`${provider}: пять отказов права за 15 минут — R18, четыре — нет`, () => {
        const four = denials(provider, rows, 4, DIFFERENT);
        expect(
          watch(provider)
            .run(four.text, four.lastMs)
            .map((s) => s.rule),
        ).not.toContain('R18');
        const five = denials(provider, rows, 5, DIFFERENT);
        const signals = watch(provider).run(five.text, five.lastMs);
        const r18 = signals.find((signal) => signal.rule === 'R18');
        expect(r18?.numbers).toMatchObject({ denials: 5 });
        expect(r18?.params).toMatchObject({ guard: 'permission' });
      });

      it(`${provider}: отбитый пуш, потом тот же пуш другой командой — R25 (обход отказа)`, () => {
        const denied = denials(provider, rows, 1);
        const bypass = executed[provider](
          denied.lastMs + 20_000,
          'bypass_1',
          'git push --no-verify origin HEAD',
        );
        const signals = watch(provider).run(denied.text + bypass, denied.lastMs + 20_500);
        expect(signals.map((signal) => signal.rule)).toContain('R25');
      });
    }

    it('qwen: отказ карточки правила — первый на вызов не стена (R18), повтор по правилу — не обход (R25)', () => {
      // Тот же вызов в ту же карточку пять раз: первый — доставка правила, четыре — стена не набралась.
      const five = denials('qwen', QWEN_HOOK, 5);
      expect(
        watch('qwen')
          .run(five.text, five.lastMs)
          .map((s) => s.rule),
      ).not.toContain('R18');
      // Шестой — уже пять повторов в стену.
      const six = denials('qwen', QWEN_HOOK, 6);
      const r18 = watch('qwen')
        .run(six.text, six.lastMs)
        .find((signal) => signal.rule === 'R18');
      expect(r18?.params).toMatchObject({ guard: 'rule-card' });
      // Исправленный повтор после карточки — то, что карточка велела, не обход.
      const card = denials('qwen', QWEN_HOOK, 1);
      const retry = executed.qwen(
        card.lastMs + 20_000,
        'retry_1',
        'git push --no-verify origin HEAD',
      );
      expect(
        watch('qwen')
          .run(card.text + retry, card.lastMs + 20_500)
          .map((s) => s.rule),
      ).not.toContain('R25');
    });
  });
});
