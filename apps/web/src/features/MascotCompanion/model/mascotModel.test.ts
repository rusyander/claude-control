import { describe, expect, it } from 'vitest';
import type { ChatSummary } from '@agentdeck/contracts';
import type { ActiveRunView } from '@shared/lib/agent-runs';
import { diffRuns, snapshotRuns } from './runEvents';
import { resolveMood, statusLine } from './mood';
import { FIRST_TIP_AFTER_MS, QUIET_INPUT_MS, TIP_GAP_MS, shouldTip } from './shouldTip';
import { companionLists, runTarget } from './chatTargets';
import type { TipGate } from './shouldTip.types';

const run = (id: string, status: ActiveRunView['status'], extra: Partial<ActiveRunView> = {}) =>
  ({ id, status, ...extra }) as ActiveRunView;

const chat = (id: string, title: string, extra: Partial<ChatSummary> = {}) =>
  ({ id, title, projectPath: 'C:/work/app', isSandbox: false, ...extra }) as ChatSummary;

describe('diffRuns', () => {
  it('first snapshot says nothing — opening the panel mid-run is not an event', () => {
    expect(diffRuns(undefined, [run('a', 'waiting'), run('b', 'error')])).toEqual([]);
  });

  it('a run that starts waiting → ask; that fails → error; once only', () => {
    const before = snapshotRuns([run('a', 'running'), run('b', 'running')]);
    const now = [run('a', 'waiting', { sessionId: 's-a' }), run('b', 'error')];
    expect(diffRuns(before, now)).toEqual([
      { kind: 'ask', id: 'a', sessionId: 's-a', projectPath: undefined },
      { kind: 'error', id: 'b', sessionId: undefined, projectPath: undefined },
    ]);
    expect(diffRuns(snapshotRuns(now), now)).toEqual([]);
  });

  it('a run that leaves while working or waiting → done; leaving from error → silence', () => {
    const before = snapshotRuns([
      run('a', 'running', { projectPath: 'C:/p' }),
      run('b', 'waiting'),
      run('c', 'error'),
      run('d', 'quiet'),
    ]);
    const kinds = diffRuns(before, []).map((event) => `${event.kind}:${event.id}`);
    expect(kinds).toEqual(['done:a', 'done:b', 'done:d']);
  });
});

describe('resolveMood', () => {
  const base = { waiting: 0, errors: 0, running: 0, asleep: false, now: 1000 };

  it('walks the priority ladder top-down', () => {
    expect(resolveMood({ ...base, waiting: 1, errors: 1, running: 2 })).toBe('waiting');
    expect(resolveMood({ ...base, errors: 1, flash: { mood: 'happy', until: 2000 } })).toBe(
      'happy',
    );
    expect(resolveMood({ ...base, errors: 1, flash: { mood: 'happy', until: 999 } })).toBe('error');
    expect(resolveMood({ ...base, running: 1, speechMood: 'thinking' })).toBe('thinking');
    expect(resolveMood({ ...base, running: 1, asleep: true })).toBe('working');
    expect(resolveMood({ ...base, asleep: true })).toBe('sleeping');
    expect(resolveMood(base)).toBe('idle');
  });

  it('status line names the single most important thing with its count', () => {
    expect(statusLine({ waiting: 2, errors: 1, running: 3, asleep: false })).toEqual({
      key: 'waiting',
      count: 2,
    });
    expect(statusLine({ waiting: 0, errors: 1, running: 3, asleep: false })).toEqual({
      key: 'error',
      count: 1,
    });
    expect(statusLine({ waiting: 0, errors: 0, running: 3, asleep: true })).toEqual({
      key: 'working',
      count: 3,
    });
    expect(statusLine({ waiting: 0, errors: 0, running: 0, asleep: true })).toEqual({
      key: 'sleeping',
    });
    expect(statusLine({ waiting: 0, errors: 0, running: 0, asleep: false })).toEqual({
      key: 'idle',
    });
  });
});

describe('shouldTip', () => {
  const now = 100 * 60_000;
  const ready: TipGate = {
    now,
    mountedAt: now - FIRST_TIP_AFTER_MS,
    lastInputAt: now - QUIET_INPUT_MS,
    chatty: true,
    hidden: false,
    asleep: false,
    panelOpen: false,
    speaking: false,
    attention: 0,
  };

  it('speaks when every «do not disturb» condition is clear', () => {
    expect(shouldTip(ready)).toBe(true);
    expect(shouldTip({ ...ready, lastSpokeAt: now - TIP_GAP_MS })).toBe(true);
  });

  it('each single disturbance keeps it quiet', () => {
    const blockers: Partial<TipGate>[] = [
      { chatty: false },
      { hidden: true },
      { asleep: true },
      { panelOpen: true },
      { speaking: true },
      { attention: 1 },
      { mountedAt: now - FIRST_TIP_AFTER_MS + 1 },
      { lastSpokeAt: now - TIP_GAP_MS + 1 },
      { lastInputAt: now - QUIET_INPUT_MS + 1 },
    ];
    for (const blocker of blockers) expect(shouldTip({ ...ready, ...blocker })).toBe(false);
  });
});

describe('chat targets', () => {
  it('a run is named by its chat title, found by id or by sessionId', () => {
    const chats = [chat('s-1', 'Починить вход'), chat('other', 'Другое')];
    expect(runTarget({ id: 'new-1', sessionId: 's-1' }, chats)).toEqual({
      chatId: 's-1',
      name: 'Починить вход',
      projectPath: 'C:/work/app',
    });
  });

  it('unknown chat → folder name; nothing at all → empty name, the run id as target', () => {
    expect(runTarget({ id: 'r', projectPath: 'C:\\work\\widget-app\\' }, [])).toEqual({
      chatId: 'r',
      name: 'widget-app',
      projectPath: 'C:\\work\\widget-app\\',
    });
    expect(runTarget({ id: 'r' }, [])).toEqual({ chatId: 'r', name: '' });
  });

  it('a sandbox chat is marked so no project tab is opened for it', () => {
    expect(runTarget({ id: 'x' }, [chat('x', 'Песочница', { isSandbox: true })]).isSandbox).toBe(
      true,
    );
  });

  it('lists: waiting from awaiting chats, errors and running (quiet counts) from runs', () => {
    const lists = companionLists(
      [run('a', 'running'), run('b', 'quiet'), run('c', 'error'), run('d', 'waiting')],
      [chat('w', 'Ждёт')],
      [],
    );
    expect(lists.waiting.map((item) => item.chatId)).toEqual(['w']);
    expect(lists.errors.map((item) => item.chatId)).toEqual(['c']);
    expect(lists.running.map((item) => item.chatId)).toEqual(['a', 'b']);
  });
});
