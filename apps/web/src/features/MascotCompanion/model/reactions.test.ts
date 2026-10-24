import { describe, expect, it } from 'vitest';
import type { ChatTreeView } from '@agentdeck/contracts/chat-handoff';
import { mascotRu } from '@shared/config/i18n/mascot/ru';
import { mascotEn } from '@shared/config/i18n/mascot/en';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import {
  EMPTY_MEMORY,
  REACTION_COOLDOWN_MS,
  REACTION_GAP_MS,
  REACTION_VARIANTS,
  pickReaction,
} from './reactions';
import { diffGroups, snapshotGroups } from './groupEvents';
import { LONG_RUN_MS, diffRuns, snapshotRuns } from './runEvents';
import type { ReactionKind, ReactionMemory } from './reactions.types';

const T0 = 1_000_000;

describe('pickReaction', () => {
  it('a burst gives ONE line — the most important kind', () => {
    const pick = pickReaction(
      ['longDone', 'runFailed', 'linkLost', 'groupDelivered'],
      EMPTY_MEMORY,
      T0,
    );
    expect(pick?.kind).toBe('linkLost');
  });

  it('never the same phrasing twice in a row, whatever the dice say', () => {
    for (const kind of Object.keys(REACTION_VARIANTS) as ReactionKind[]) {
      let memory: ReactionMemory = EMPTY_MEMORY;
      let previous: number | undefined;
      // Каждый шаг — за сроком повтора, кубик — все крайние значения по кругу.
      for (const [step, roll] of [0, 0.5, 0.9999, 0, 0, 0.9999].entries()) {
        const pick = pickReaction([kind], memory, T0 + step * REACTION_COOLDOWN_MS, () => roll);
        expect(pick).not.toBeNull();
        if (!pick) return;
        expect(pick.variant).toBeGreaterThanOrEqual(0);
        expect(pick.variant).toBeLessThan(REACTION_VARIANTS[kind]);
        if (previous !== undefined) expect(pick.variant).not.toBe(previous);
        previous = pick.variant;
        memory = pick.memory;
      }
    }
  });

  it('same kind inside the cooldown is skipped; the next kind of the burst speaks instead', () => {
    const first = pickReaction(['runFailed'], EMPTY_MEMORY, T0);
    expect(first?.kind).toBe('runFailed');
    const later = T0 + REACTION_GAP_MS + 1;
    expect(pickReaction(['runFailed'], first!.memory, later)).toBeNull();
    expect(pickReaction(['runFailed', 'longDone'], first!.memory, later)?.kind).toBe('longDone');
    expect(pickReaction(['runFailed'], first!.memory, T0 + REACTION_COOLDOWN_MS)?.kind).toBe(
      'runFailed',
    );
  });

  it('inside the global gap nothing speaks — except «back», which answers «lost»', () => {
    const lost = pickReaction(['linkLost'], EMPTY_MEMORY, T0);
    const soon = T0 + REACTION_GAP_MS - 1;
    expect(pickReaction(['groupFailed'], lost!.memory, soon)).toBeNull();
    expect(pickReaction(['linkBack'], lost!.memory, soon)?.kind).toBe('linkBack');
  });

  it('every kind has exactly its number of phrasings in ru and en', () => {
    for (const [kind, count] of Object.entries(REACTION_VARIANTS)) {
      expect(mascotRu.react[kind as ReactionKind]).toHaveLength(count);
      expect(mascotEn.react[kind as ReactionKind]).toHaveLength(count);
    }
  });
});

const run = (id: string, status: ActiveRunView['status'], extra: Partial<ActiveRunView> = {}) =>
  ({ id, status, ...extra }) as ActiveRunView;

describe('diffRuns: limit and long turns', () => {
  it('a limit refusal → limit, and the failure it causes is not reported again as error', () => {
    const before = snapshotRuns([run('a', 'running')]);
    const hit = [run('a', 'error', { limitHit: true })];
    expect(diffRuns(before, hit).map((event) => event.kind)).toEqual(['limit']);
    expect(diffRuns(snapshotRuns(hit), hit)).toEqual([]);
  });

  it('done of a run started ≥ 10 min ago carries `long`; a short one does not', () => {
    const now = T0 + LONG_RUN_MS;
    const before = snapshotRuns([
      run('long', 'running', { startedAt: T0 }),
      run('short', 'running', { startedAt: now - 60_000 }),
    ]);
    const events = diffRuns(before, [], now);
    expect(events.find((event) => event.id === 'long')?.long).toBe(true);
    expect(events.find((event) => event.id === 'short')).not.toHaveProperty('long');
  });
});

const tree = (statuses: string[]): ChatTreeView =>
  ({
    root: 'root',
    running: 0,
    nodes: [],
    split: {
      groups: statuses.map((status, index) => ({ index, title: `G${index}`, status })),
    },
  }) as unknown as ChatTreeView;

describe('diffGroups', () => {
  it('first sight of a tree says nothing — an old failure is not news', () => {
    expect(diffGroups(undefined, tree(['failed', 'done']))).toEqual([]);
  });

  it('started → failed / paused / done give failed, stopped, delivered; no change — nothing', () => {
    const before = snapshotGroups(tree(['started', 'started', 'started', 'started']));
    const kinds = diffGroups(before, tree(['failed', 'paused', 'done', 'started'])).map(
      (event) => `${event.kind}:${event.title}`,
    );
    expect(kinds).toEqual(['groupFailed:G0', 'groupStopped:G1', 'groupDelivered:G2']);
  });
});
