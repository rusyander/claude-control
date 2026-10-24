import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { GroupWatcher, WATCH_TICK_MS, type TranscriptHint } from './group-watcher.ts';

/**
 * Сторож у группы чужого CLI (Qwen Code, Codex): потока событий нет, только
 * старт и конец хода, — события он берёт из переписки CLI (`foreign-events`).
 * Строки здесь — той же формы, что пишет настоящий qwen 0.24.3 (`__fixtures__`).
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

const user = (ms: number, text: string): string =>
  `${JSON.stringify({ type: 'user', provenance: 'real_user', timestamp: at(ms), message: { role: 'user', parts: [{ text }] } })}\n`;
const call = (ms: number, id: string): string =>
  `${JSON.stringify({
    type: 'system',
    subtype: 'ui_telemetry',
    timestamp: at(ms),
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        response_id: id,
        model: 'qwen3-coder-plus',
        input_token_count: 9000,
        cached_content_token_count: 4000,
        output_token_count: 20,
      },
    },
  })}\n`;
const check = (ms: number, id: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: at(ms),
    message: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id,
            name: 'run_shell_command',
            args: { command: 'npx vitest run src/a.test.ts' },
          },
        },
      ],
    },
  })}\n${JSON.stringify({
    type: 'tool_result',
    timestamp: at(ms + 1000),
    message: {
      role: 'user',
      parts: [{ functionResponse: { id, response: { output: 'Tests 3 passed' } } }],
    },
  })}\n`;

describe('GroupWatcher (foreign CLI)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-foreign-'));
    file = join(dir, 'session.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(transcript: (id: string, hint?: TranscriptHint) => string | undefined) {
    let now = T0;
    const settings: GroupWatch = { ...GROUP_WATCH_DEFAULTS };
    const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
    const hints: Array<TranscriptHint | undefined> = [];
    const watcher = new GroupWatcher({
      settings: () => settings,
      resolve: (chatId) =>
        chatId === 'qwen:child'
          ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work', cwd: dir }
          : undefined,
      group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
      save: () => {},
      node: () => ({ running: true, paused: false }),
      transcript: (id, hint) => {
        hints.push(hint);
        return transcript(id, hint);
      },
      // Каталог субагентов Claude у чужого CLI не ищется.
      subagentDir: () => {
        throw new Error('subagentDir must not be asked for a foreign session');
      },
      now: () => now,
      makeId: () => 'id',
      plans: () => ({ parent: { groups: [group] } }),
    });
    const start = (sessionId: string) =>
      watcher.onFeed('qwen:child', {
        kind: 'start',
        sessionId,
        cwd: dir,
        detached: true,
        provider: 'qwen',
      });
    return {
      watcher,
      group,
      hints,
      start,
      at: (t: number) => {
        now = t;
      },
      active: () => (group.watch?.signals ?? []).filter((signal) => !signal.clearedAt),
    };
  }

  it('R1: a silent foreign group is a stall once its transcript is read', () => {
    const w = setup((id, hint) =>
      hint?.provider === 'qwen' && id === 'qwen:child' ? file : undefined,
    );
    w.start('qwen:child');
    // Первый ход: файл начат после старта хода — читается с начала.
    writeFileSync(file, user(1000, 'go') + call(2000, 'c1'));
    w.at(T0 + MIN);
    w.watcher.tick();
    expect(w.active()).toEqual([]);
    // Ни строки 25 минут, ход не кончился — зависание (порог 20 минут).
    w.at(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.active().map((signal) => signal.rule)).toEqual(['R1']);
    // Подсказка поиска — провайдер, копия и начало хода.
    expect(w.hints.find(Boolean)).toEqual({ provider: 'qwen', cwd: dir, since: T0 });
  });

  it('no transcript (yet) is no evidence: silence then is not a stall', () => {
    const w = setup(() => undefined);
    w.start('qwen:child');
    w.at(T0 + 25 * MIN);
    w.watcher.tick();
    expect(w.active()).toEqual([]);
  });

  it('the real session id keeps the read cursor, and finish drains the last lines', () => {
    const w = setup((id, hint) =>
      hint?.provider === 'qwen' && (id === 'qwen:child' || id === 's-real') ? file : undefined,
    );
    w.start('qwen:child');
    writeFileSync(file, user(1000, 'go') + check(2000, 't1') + check(4000, 't2'));
    w.at(T0 + MIN);
    w.watcher.tick();
    // Два прогона одной проверки — ещё не повтор (R4 с трёх).
    expect(w.active()).toEqual([]);
    // Третий прогон дописан после тика; конец хода приходит раньше следующего тика
    // и уже с настоящим id: дочитать хвост, прочитанное заново не читать.
    appendFileSync(file, check(MIN + 5000, 't3'));
    w.at(T0 + MIN + 10_000);
    w.watcher.onFeed('qwen:child', { kind: 'finish', sessionId: 's-real' });
    const signals = w.active();
    expect(signals.map((signal) => signal.rule)).toEqual(['R4']);
    expect(signals[0]?.numbers).toEqual({ runs: 3 });
    // Следующий тик того же файла под настоящим id — ничего нового.
    w.at(T0 + MIN + 10_000 + WATCH_TICK_MS);
    w.watcher.tick();
    expect(w.active()[0]?.numbers).toEqual({ runs: 3 });
  });

  it('R19: the first turn under the placeholder is a new conversation; a resumed one is not', () => {
    const heavy = (prompt: number) =>
      call(2000, 'h1').replace('"input_token_count":9000', `"input_token_count":${prompt}`);
    const w = setup((_id, hint) => (hint?.provider === 'qwen' ? file : undefined));
    w.start('qwen:child');
    writeFileSync(file, user(1000, 'go') + heavy(95_000));
    w.at(T0 + 10_000);
    w.watcher.onFeed('qwen:child', { kind: 'finish', sessionId: 's-real' });
    expect(w.active().map((signal) => signal.rule)).toEqual(['R19']);
    expect(w.active()[0]?.numbers).toEqual({ firstK: 95 });

    // Тот же тяжёлый вызов в продолженной сессии (настоящий id) — не первый запрос.
    rmSync(file);
    const r = setup((_id, hint) => (hint?.provider === 'qwen' ? file : undefined));
    r.start('s-old');
    writeFileSync(file, user(1000, 'go') + heavy(95_000));
    r.at(T0 + 10_000);
    r.watcher.onFeed('qwen:child', { kind: 'finish', sessionId: 's-old' });
    expect(r.active()).toEqual([]);
  });

  it('a resumed session is read from its end at the turn start, not from its past', () => {
    // Прошлый ход — до старта нынешнего: три прогона проверки не в счёт.
    writeFileSync(
      file,
      user(-10 * MIN, 'go') + check(-9 * MIN, 'o1') + check(-8 * MIN, 'o2') + check(-7 * MIN, 'o3'),
    );
    const w = setup((id, hint) => (hint?.provider === 'qwen' && id === 's-old' ? file : undefined));
    w.start('s-old');
    w.at(T0 + MIN);
    w.watcher.tick();
    expect(w.active()).toEqual([]);
  });
});
