import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GROUP_ECONOMY_DEFAULTS } from '@agentdeck/contracts/group-economy';
import type { AppStore } from '../../../lib/app-store/store.ts';
import { qwenProjectSlug } from '../token-ledger/foreign/foreign-transcript.ts';
import { COLD_RESUME_INTRO } from '../split-continue.ts';
import { FOREIGN_COLD_AFTER_MS, FOREIGN_COLD_TAIL, foreignColdPlan } from './foreign-cold.ts';
import { createForeignColdPlan } from './foreign-cold-plan.ts';

/**
 * Группа Qwen Code после паузы: переписка той же формы, что пишет qwen 0.24.3
 * (`ui_telemetry` с окном вызова, ответ модели — `parts[].text`).
 */

const CODEX_FIXTURES = join(import.meta.dirname, '..', 'token-ledger', 'foreign', '__fixtures__');
const T0 = Date.parse('2026-10-22T10:00:00Z');
const at = (ms: number): string => new Date(T0 + ms).toISOString();
const MIN = 60_000;

const call = (ms: number, prompt: number): string =>
  `${JSON.stringify({
    type: 'system',
    subtype: 'ui_telemetry',
    timestamp: at(ms),
    systemPayload: {
      uiEvent: {
        'event.name': 'qwen-code.api_response',
        response_id: `r${ms}`,
        model: 'qwen3-coder-plus',
        input_token_count: prompt,
        cached_content_token_count: Math.floor(prompt / 2),
        output_token_count: 20,
      },
    },
  })}\n`;
const answer = (ms: number, text: string): string =>
  `${JSON.stringify({
    type: 'assistant',
    timestamp: at(ms),
    message: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text }] },
  })}\n`;

/** Сессия: первый вызов 9 тысяч, последний — 60 тысяч (выше базы + 25k). */
const big = (): string =>
  call(1000, 9000) +
  answer(2000, 'Step one done.') +
  call(3000, 60_000) +
  answer(4000, 'Tests pass, committed.');

describe('foreign-cold', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-foreign-cold-'));
    file = join(dir, 's1.jsonl');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const plan = (patch: Partial<Parameters<typeof foreignColdPlan>[0]>) =>
    foreignColdPlan({ kind: 'qwen', file, previous: 's1', cwd: dir, now: T0, ...patch });

  it('fresh after gap, resume before', () => {
    writeFileSync(file, big());
    const last = T0 + 4000;
    // Пауза короче срока кэша DashScope — продолжать.
    expect(plan({ now: last + FOREIGN_COLD_AFTER_MS.qwen - 1 })).toEqual({ kind: 'resume' });
    const fresh = plan({ now: last + FOREIGN_COLD_AFTER_MS.qwen });
    expect(fresh).toMatchObject({ kind: 'fresh', tail: FOREIGN_COLD_TAIL, contextTokens: 60_000 });
    if (fresh.kind !== 'fresh') return;
    expect(fresh.brief.startsWith(COLD_RESUME_INTRO)).toBe(true);
    // Итог прежней стадии — последний ответ модели, без размышлений.
    expect(fresh.brief).toContain('## Your last answer in the previous conversation');
    expect(fresh.brief).toContain('Tests pass, committed.');
    expect(fresh.brief).not.toContain('thinking…');
    expect(fresh.notice).toContain('60');
    expect(fresh.notice).toContain('s1');
    // У Codex срок дольше: та же пауза — ещё продолжение.
    expect(FOREIGN_COLD_AFTER_MS.codex).toBeGreaterThan(FOREIGN_COLD_AFTER_MS.qwen);
  });

  it('a small window resumes even when cold: a fresh start would cost the same', () => {
    writeFileSync(file, call(1000, 9000) + call(3000, 30_000));
    expect(plan({ now: T0 + 60 * MIN })).toEqual({ kind: 'resume' });
  });

  it('local never goes fresh', () => {
    writeFileSync(file, big());
    expect(plan({ now: T0 + 600 * MIN, local: true })).toEqual({ kind: 'resume' });
  });

  it('own cold-after (QA seam) overrides the provider default', () => {
    writeFileSync(file, big());
    expect(plan({ now: T0 + 4000 + 1000, coldAfterMs: 1000 })).toMatchObject({ kind: 'fresh' });
  });

  it('no transcript is no evidence: resume', () => {
    expect(plan({ now: T0 + 600 * MIN })).toEqual({ kind: 'resume' });
  });

  // Решение O4: сроки провайдеров закреплены числами — правка любого видна здесь.
  it('cold gaps (O4): Qwen Code 5 minutes, Codex 10 minutes', () => {
    expect(FOREIGN_COLD_AFTER_MS).toEqual({ qwen: 300_000, codex: 600_000 });
  });

  /**
   * Codex — на настоящей переписке codex 0.155 (`__fixtures__`): последний вызов
   * поднят до 60 тысяч, чтобы окно было выше базы (первый вызов, 9 тысяч) + 25k.
   */
  function codexSession(): number {
    const rows = readFileSync(join(CODEX_FIXTURES, 'codex-0.155-two-turns.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const records = rows.filter((row) => row.type === 'token_usage_record');
    const last = records.at(-1)?.payload as { usage: Record<string, number> } | undefined;
    if (!last) throw new Error('fixture without token_usage_record');
    last.usage.input_tokens = 60_000;
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
    return Date.parse(String(rows.at(-1)?.timestamp));
  }

  it('Codex: resume at 9:59 of silence, fresh at 10:00, last answer from output_text', () => {
    const last = codexSession();
    const codex = (now: number) => plan({ kind: 'codex', now });
    expect(codex(last + 10 * MIN - 1000)).toEqual({ kind: 'resume' });
    const fresh = codex(last + 10 * MIN);
    expect(fresh).toMatchObject({ kind: 'fresh', contextTokens: 60_000 });
    if (fresh.kind !== 'fresh') return;
    expect(fresh.brief).toContain('ANSWER-6 done with the step.');
    // Пауза, остудившая бы Qwen Code (5 минут), у Codex — ещё продолжение.
    expect(codex(last + 5 * MIN)).toEqual({ kind: 'resume' });
  });
});

describe('createForeignColdPlan', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-foreign-cold-plan-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function setup(freshOnColdResume: boolean) {
    const copy = join(dir, 'copy');
    mkdirSync(copy);
    const chats = join(dir, 'kit', 'qwen-home', 'projects', qwenProjectSlug(copy), 'chats');
    mkdirSync(chats, { recursive: true });
    const file = join(chats, 's1.jsonl');
    writeFileSync(file, big());
    utimesSync(file, new Date(T0), new Date(T0));
    const store = {
      getSettings: () => ({ groupEconomy: { ...GROUP_ECONOMY_DEFAULTS, freshOnColdResume } }),
      getChatLink: (key: string) =>
        key === 'qwen:child'
          ? { parentChatId: 'p', groupIndex: 0, createdAt: at(0), task: 'Finish the group.' }
          : undefined,
      getSplitPlan: () => undefined,
    } as unknown as Pick<AppStore, 'getChatLink' | 'getSettings' | 'getSplitPlan'>;
    // Переписка ищется по копии `copy` в доме Qwen Code набора панели.
    return createForeignColdPlan({ store, appDataDir: dir, now: () => T0 + 60 * MIN });
  }

  const request = (patch: object = {}) => ({
    providerId: 'qwen',
    chatId: 'child',
    workdir: join(dir, 'copy'),
    session: { kind: 'qwen', id: 's1' },
    ...patch,
  });

  it('a group of Qwen Code after a pause starts fresh with the brief and the task', () => {
    const decide = setup(true);
    const decided = decide(request());
    expect(decided).toMatchObject({ kind: 'fresh', tail: FOREIGN_COLD_TAIL });
    expect(decided && 'brief' in decided ? decided.brief : '').toContain('Finish the group.');
    // Локальная модель — продолжение.
    expect(decide(request({ local: true }))).toEqual({ kind: 'resume' });
  });

  it('lever off, not a group, no session — no decision', () => {
    expect(setup(false)(request())).toBeUndefined();
    rmSync(join(dir, 'copy'), { recursive: true, force: true });
    rmSync(join(dir, 'kit'), { recursive: true, force: true });
    const decide = setup(true);
    expect(decide(request({ chatId: 'other' }))).toBeUndefined();
    expect(decide(request({ session: undefined }))).toBeUndefined();
    expect(decide(request({ session: { kind: 'qwen', id: 'missing' } }))).toBeUndefined();
    expect(decide(request({ providerId: 'goose' }))).toBeUndefined();
  });
});
