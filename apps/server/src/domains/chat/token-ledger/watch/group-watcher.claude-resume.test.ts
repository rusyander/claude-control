import { describe, expect, it } from 'vitest';
import { GROUP_WATCH_DEFAULTS } from '@agentdeck/contracts/group-watch';
import type { SplitPlanGroupRecord } from '../../../../lib/app-store/app-store.types.ts';
import type { ChatEvent } from '../../chat-events.ts';
import { GroupWatcher } from './group-watcher.ts';

/**
 * Claude Code: реестр прогонов держит продолженный чат под id его сессии
 * (`ChatRunRegistry` шлёт `start {sessionId}` под ключом, равным этому id).
 * Правило «ключ разговора на месте id — новый разговор» — только для чужого
 * CLI (`provider`): у Claude такой старт — продолжение, и R19/R2 обязаны это
 * различать. Без проверки провайдера каждый продолженный ход Claude стал бы
 * «новым разговором»: R19 — ложно, R2 — молча.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');

function setup() {
  let now = T0;
  const group = { index: 1, title: 'g', status: 'started' } as SplitPlanGroupRecord;
  const watcher = new GroupWatcher({
    settings: () => ({ ...GROUP_WATCH_DEFAULTS }),
    resolve: (chatId) =>
      chatId === 's-claude'
        ? { chatId, parentChatId: 'parent', groupIndex: 1, stage: 'work' }
        : undefined,
    group: (parent, index) => (parent === 'parent' && index === 1 ? group : undefined),
    save: () => {},
    node: () => ({ running: true, paused: false }),
    now: () => now,
    makeId: () => 'id',
    plans: () => ({ parent: { groups: [group] } }),
  });
  return {
    watcher,
    at: (t: number) => {
      now = t;
    },
    // Ключ чата = id сессии, провайдера нет — так стартует продолженный чат Claude.
    start: () => watcher.onFeed('s-claude', { kind: 'start', sessionId: 's-claude', cwd: '/w' }),
    event: (event: ChatEvent) =>
      watcher.onFeed('s-claude', { kind: 'event', event, sessionId: 's-claude' }),
    finish: () => watcher.onFeed('s-claude', { kind: 'finish', sessionId: 's-claude' }),
    rules: () => (group.watch?.signals ?? []).map((signal) => signal.rule),
  };
}

const usage = (cacheCreation: number, cacheRead = 0): ChatEvent => ({
  kind: 'usage',
  input: 10,
  output: 10,
  cacheRead,
  cacheCreation,
});

describe('GroupWatcher (Claude resume keyed by its session id)', () => {
  it('a start whose session id equals the chat key is a resume: no R19 on a heavy call', () => {
    const w = setup();
    w.start();
    w.event(usage(110_000));
    expect(w.rules()).not.toContain('R19');
  });

  it('a resumed Claude turn after a long pause is a cold rewrite (R2), not a new conversation', () => {
    const w = setup();
    w.start();
    w.event(usage(30_000));
    w.finish();
    w.at(T0 + 70 * MIN);
    w.start();
    w.event(usage(150_000));
    const rules = w.rules();
    expect(rules).toContain('R2');
    expect(rules).not.toContain('R19');
  });
});
