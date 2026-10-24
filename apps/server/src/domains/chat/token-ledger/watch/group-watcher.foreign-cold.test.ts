import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import { FOREIGN_COLD_AFTER_MS, foreignColdRule } from '../foreign/foreign-cache.ts';
import { GroupWatcher, IDLE_DROP_MS } from './group-watcher.ts';

/**
 * R2 у чужого CLI судит по кэшу ЕГО провайдера: срок остывания свой (Qwen Code —
 * 5 минут, Codex — 10, решение O4), не часовой Claude из настроек (55 минут);
 * записи кэша провайдер не сообщает — след холодного продолжения — чтение кэша,
 * упавшее после паузы. Локальная модель и провайдер, не сообщающий чтения, —
 * без сигнала. Строки переписки — той же формы, что пишут qwen 0.24.3 и
 * codex 0.155 (`foreign/__fixtures__`).
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();

type Call = { ms: number; id: string; prompt: number; cached: number };

const qwenCall = ({ ms, id, prompt, cached }: Call): string =>
  `${JSON.stringify({
    type: 'system',
    subtype: 'ui_telemetry',
    timestamp: at(ms),
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        response_id: id,
        model: 'qwen3-coder-plus',
        input_token_count: prompt,
        cached_content_token_count: cached,
        output_token_count: 20,
      },
    },
  })}\n`;

const codexCall = ({ ms, id, prompt, cached }: Call): string =>
  `${JSON.stringify({
    timestamp: at(ms),
    type: 'token_usage_record',
    payload: {
      response_id: id,
      usage: {
        input_tokens: prompt,
        cached_input_tokens: cached,
        cache_write_input_tokens: 0,
        output_tokens: 20,
      },
    },
  })}\n`;

describe('GroupWatcher R2 on a foreign CLI (its own cache clock)', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-foreign-cold-'));
    file = join(dir, 'session.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(provider: 'qwen' | 'codex') {
    let now = T0;
    const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
    const chatId = `${provider}:child`;
    const row = provider === 'qwen' ? qwenCall : codexCall;
    const watcher = new GroupWatcher({
      settings: () => ({ ...GROUP_WATCH_DEFAULTS }),
      resolve: (key) =>
        key === chatId
          ? { chatId: key, parentChatId: 'parent', groupIndex: 1, stage: 'work', cwd: dir }
          : undefined,
      group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
      save: () => {},
      node: () => ({ running: true, paused: false }),
      transcript: (_id, hint) => (hint?.provider === provider ? file : undefined),
      now: () => now,
      makeId: () => 'id',
      plans: () => ({ parent: { groups: [group] } }),
    });
    const start = (sessionId: string, local = false) =>
      watcher.onFeed(chatId, {
        kind: 'start',
        sessionId,
        cwd: dir,
        detached: true,
        provider,
        ...(local ? { local: true } : {}),
      });
    const finish = (sessionId: string) => watcher.onFeed(chatId, { kind: 'finish', sessionId });
    /**
     * Первый ход: два вызова — 9 тысяч без кэша (база), затем 40 тысяч, из них
     * `cachedBefore` прочитано из кэша; ход кончается на 10-й секунде.
     */
    const firstTurn = (cachedBefore = 30_000) => {
      start(chatId);
      writeFileSync(
        file,
        row({ ms: 1000, id: 'c1', prompt: 9000, cached: 0 }) +
          row({ ms: 2000, id: 'c2', prompt: 40_000, cached: cachedBefore }),
      );
      now = T0 + 10_000;
      finish('s1');
    };
    /** Продолжение той же сессии через `gapMs` после последнего вызова: окно `prompt`. */
    const resume = (gapMs: number, cached: number, local = false, prompt = 70_000) => {
      now = T0 + 2000 + gapMs - 1000;
      start('s1', local);
      appendFileSync(file, row({ ms: 2000 + gapMs, id: 'c3', prompt, cached }));
      now = T0 + 2000 + gapMs + 5000;
      finish('s1');
    };
    return {
      watcher,
      firstTurn,
      resume,
      tick: (t: number) => {
        now = t;
        watcher.tick();
      },
      r2: () => (group.watch?.signals ?? []).filter((signal) => signal.rule === 'R2'),
    };
  }

  it('Qwen Code: 6 minutes of silence and the cache read gone — R2, well before Claude’s 55', () => {
    const w = setup('qwen');
    w.firstTurn();
    w.resume(6 * MIN, 0);
    const r2 = w.r2();
    expect(r2).toHaveLength(1);
    // Из кэша выпали 30 тысяч окна — они и есть потеря: остальные 40 тысяч нового
    // входа шли бы полной ценой и с тёплым кэшем. Пауза 6 минут.
    expect(r2[0]?.numbers).toMatchObject({ writeK: 30, gapMin: 6 });
  });

  it('Qwen Code: 4 minutes of silence is inside its 5-minute cache — no R2', () => {
    const w = setup('qwen');
    w.firstTurn();
    w.resume(4 * MIN, 0);
    expect(w.r2()).toEqual([]);
  });

  it('Codex: 6 minutes is still warm for OpenAI (10 minutes) — no R2; 11 minutes — R2', () => {
    const warm = setup('codex');
    warm.firstTurn();
    warm.resume(6 * MIN, 0);
    expect(warm.r2()).toEqual([]);

    rmSync(file);
    const cold = setup('codex');
    cold.firstTurn();
    cold.resume(11 * MIN, 0);
    expect(cold.r2().map((signal) => signal.numbers)).toEqual([
      expect.objectContaining({ writeK: 30, gapMin: 11 }),
    ]);
    // Потеря — выпавшее из кэша полной ценой (×1) вместо чтения (×0.1), не цена записи кэша
    // Claude (×1.25): 30 тысяч × 0.9 × 5 (модель не названа — множитель по умолчанию) / 1e6 ≈ 0.135 → 0.14 W.
    expect(cold.r2()[0]?.numbers.lostW).toBeCloseTo(0.14, 2);
  });

  it('Codex: the session forgotten while idle keeps its cache read in the seed — R2 after 11 minutes', () => {
    const w = setup('codex');
    w.firstTurn();
    // Тишина дольше IDLE_DROP_MS — сторож забыл сессию, осталась затравка.
    w.tick(T0 + 10_000 + IDLE_DROP_MS + 1000);
    expect(w.watcher.watched).toBe(0);
    w.resume(11 * MIN, 0);
    expect(w.r2()).toHaveLength(1);
  });

  it('a local model pays no provider cache: an hour of silence and no cache read — no R2', () => {
    const w = setup('qwen');
    w.firstTurn();
    w.resume(60 * MIN, 0, true);
    expect(w.r2()).toEqual([]);
  });

  it('a provider that never reported a cache read gives no evidence — no R2 even after an hour', () => {
    const w = setup('qwen');
    w.firstTurn(0);
    w.resume(60 * MIN, 0);
    expect(w.r2()).toEqual([]);
  });

  it('the cache still read after the pause is a warm resume — no R2', () => {
    const w = setup('codex');
    w.firstTurn();
    // Окно выросло (100 тысяч, 61 из них полной ценой), но чтение не упало — кэш жив.
    w.resume(30 * MIN, 39_000, false, 100_000);
    expect(w.r2()).toEqual([]);
  });

  it('Codex compacted the conversation: the next call reads no cache by design — no R2', () => {
    const w = setup('codex');
    w.firstTurn();
    // Сжатие меняет начало разговора — прежнее чтение кэша больше не мерило.
    appendFileSync(
      file,
      `${JSON.stringify({ timestamp: at(3000), type: 'compacted', payload: {} })}\n`,
    );
    w.resume(11 * MIN, 0);
    expect(w.r2()).toEqual([]);
  });

  it('the cache read dropped but the window barely grew past the base — no R2', () => {
    const w = setup('qwen');
    w.firstTurn();
    // 30 тысяч полной ценой — ниже базы (9) + запас (25): новый разговор стоил бы столько же.
    w.resume(60 * MIN, 0, false, 30_000);
    expect(w.r2()).toEqual([]);
  });
});

describe('foreignColdRule', () => {
  it('own cold gap per provider, local and unknown CLIs off, the QA override wins', () => {
    expect(foreignColdRule('qwen')).toEqual({
      kind: 'readDrop',
      afterMs: FOREIGN_COLD_AFTER_MS.qwen,
    });
    expect(foreignColdRule('codex')).toEqual({ kind: 'readDrop', afterMs: 600_000 });
    expect(foreignColdRule('qwen', { local: true })).toEqual({ kind: 'off' });
    expect(foreignColdRule('goose')).toEqual({ kind: 'off' });
    expect(foreignColdRule('codex', { coldAfterMs: 2000 })).toEqual({
      kind: 'readDrop',
      afterMs: 2000,
    });
  });
});
