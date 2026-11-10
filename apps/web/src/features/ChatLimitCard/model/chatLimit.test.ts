import { describe, expect, it } from 'vitest';
import type { ProviderDetectResponse } from '@agentdeck/contracts';
import type { CarryPlan } from '@agentdeck/contracts/portable-carry';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import {
  answeredAfterReset,
  carryCandidateOf,
  carryTargetsOf,
  chatOffers,
  limitHolds,
  panelResend,
  resetAtOf,
  resetLabel,
} from './chatLimit';

const STEP = '01900000-0000-7000-8000-0000000d0201';

const row = (
  id: string,
  cliInstalled: boolean,
  configPresent: boolean,
): ProviderDetectResponse['providers'][number] => ({
  id,
  name: id,
  status: 'verified',
  cliCommand: id,
  cliInstalled,
  configPresent,
  configPaths: [],
});
/** Детект панели: claude, codex и gemini с входом; qwen стоит без конфигурации; kimi не стоит. */
const detect: ProviderDetectResponse = {
  active: 'claude',
  providers: [
    row('claude', true, true),
    row('codex', true, true),
    row('qwen', true, false),
    row('kimi', false, true),
    row('gemini', true, true),
  ],
};

function view(offers: string[] | undefined, resetAt: number | null = null): TaskView {
  return {
    asks: [],
    windowWait: {
      stepId: STEP,
      routeId: 'claude-login',
      verdict: 'refused',
      resetAt,
      alternatives: [],
      skipped: [],
      ...(offers ? { offers } : {}),
      seq: 3,
    },
  } as unknown as TaskView;
}

describe('chat limit card (stage 12, L3, P171)', () => {
  it('the limit holds only while the window refusal ended the turn', () => {
    expect(limitHolds({ limitHit: true, error: "You've hit your limit" })).toBe(true);
    // Новый ход сбрасывает ошибку, флаг окна стор не сбрасывает — лимит больше не держит.
    expect(limitHolds({ limitHit: true })).toBe(false);
    expect(limitHolds({ limitHit: false, error: 'API Error: 500' })).toBe(false);
    expect(limitHolds({ error: 'API Error: 500' })).toBe(false);
  });

  it('P171: core resume + panel resend would be two turns — panel retry/continue are withheld while the limit holds', () => {
    const retry = () => undefined;
    expect(panelResend({ limitHit: true, error: 'limit' }, retry)).toBeUndefined();
    expect(panelResend({ limitHit: false, error: 'API Error: 500' }, retry)).toBe(retry);
    expect(panelResend({ limitHit: true }, retry)).toBe(retry);
    expect(panelResend({ limitHit: true, error: 'limit' }, undefined)).toBeUndefined();
  });

  it('reset time: the core view wins, else the stream window event (seconds → ms), else unknown', () => {
    expect(resetAtOf({ limitResetsAt: 100 }, view([], 5_000_000))).toBe(5_000_000);
    expect(resetAtOf({ limitResetsAt: 100 }, view([], null))).toBe(100_000);
    expect(resetAtOf({ limitResetsAt: 100 }, undefined)).toBe(100_000);
    expect(resetAtOf({}, undefined)).toBeNull();
    expect(resetLabel(Date.UTC(2026, 10, 8, 14, 30), 'ru')).toMatch(/^\d{2}:30$/);
  });

  it('offers: core models first, then the panel carry targets; the core cli: offers are not carry targets', () => {
    const targets = carryTargetsOf(detect, 'claude');
    expect(chatOffers(view(['cli:qwen', 'model:sonnet', 'bogus', 'model:']), targets)).toEqual([
      { option: 'model:sonnet', kind: 'model', value: 'sonnet' },
      { option: 'cli:codex', kind: 'cli', value: 'codex' },
      { option: 'cli:gemini', kind: 'cli', value: 'gemini' },
    ]);
    // Вида задачи нет или окна в нём нет — переносу это не мешает: лимит держит поток.
    expect(chatOffers(view(undefined), targets).map((o) => o.option)).toEqual([
      'cli:codex',
      'cli:gemini',
    ]);
    expect(chatOffers(undefined, targets).map((o) => o.option)).toEqual([
      'cli:codex',
      'cli:gemini',
    ]);
    expect(chatOffers({ asks: [], windowWait: null } as unknown as TaskView, [])).toEqual([]);
  });

  it('carry targets: every installed CLI with its config, except the conversation CLI', () => {
    expect(carryTargetsOf(detect, 'claude').map((o) => o.value)).toEqual(['codex', 'gemini']);
    // Разговор Codex: Claude — цель, сам Codex — нет.
    expect(carryTargetsOf(detect, 'codex').map((o) => o.value)).toEqual(['claude', 'gemini']);
    expect(carryTargetsOf(undefined, 'claude')).toEqual([]);
    expect(carryTargetsOf(detect, undefined)).toEqual([]);
  });

  it('carry candidate: matched by the conversation key or its provider id, never another conversation', () => {
    const one = { key: 'sess-1', chatId: 'chat-1', ready: true };
    const plan = { target: 'codex', candidates: [one] } as unknown as CarryPlan;
    expect(carryCandidateOf(plan, 'sess-1')).toBe(one);
    expect(carryCandidateOf(plan, 'chat-1')).toBe(one);
    expect(carryCandidateOf(plan, 'sess-2')).toBeUndefined();
    expect(carryCandidateOf(plan, undefined)).toBeUndefined();
    expect(carryCandidateOf(undefined, 'sess-1')).toBeUndefined();
  });

  it('answer after the reset: a model reply at or after the reset clears; earlier replies, human words or an unknown reset do not', () => {
    const reset = Date.parse('2026-11-08T12:00:00.000Z');
    const before = { role: 'assistant' as const, timestamp: '2026-11-08T11:59:59.000Z' };
    const human = { role: 'user' as const, timestamp: '2026-11-08T12:00:05.000Z' };
    const after = { role: 'assistant' as const, timestamp: '2026-11-08T12:00:00.000Z' };
    expect(answeredAfterReset([before, human], reset)).toBe(false);
    expect(answeredAfterReset([before, human, after], reset)).toBe(true);
    expect(answeredAfterReset([before, human, after], null)).toBe(false);
    expect(answeredAfterReset([], reset)).toBe(false);
  });
});
