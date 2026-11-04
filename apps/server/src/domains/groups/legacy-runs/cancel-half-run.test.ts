import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppStore } from '../../../lib/app-store/store.ts';
import { DEFERRED_ASKS_FILE, DeferredAsks } from '../../chat/deferred-asks/deferred-asks.ts';
import type { SplitGroupStatus, SplitPlanRecord } from '../../../lib/app-store/app-store.types.ts';
import { cancelHalfRunPlans } from './cancel-half-run.ts';
import { legacyGroupRuns } from './legacy-runs.ts';

/**
 * Миграция `cancelledAt` при старте (этап 10, F1) — на временном каталоге данных, настоящим
 * хранилищем панели: запись уходит в state.json и читается новым хранилищем, как после
 * перезапуска. Настоящие данные машины тест не трогает.
 */
function plan(id: string, statuses: SplitGroupStatus[], extra: Partial<SplitPlanRecord> = {}) {
  return {
    parentChatId: id,
    projectPath: '/repo',
    copyRoot: '/copies',
    createdAt: '2026-10-01T00:00:00.000Z',
    order: statuses.map((_, i) => i),
    request: {},
    proposal: { groups: [] },
    groups: statuses.map((status, index) => ({
      index,
      title: `g${index}`,
      branch: `b${index}`,
      after: [],
      status,
    })),
    ...extra,
  } as SplitPlanRecord;
}

describe('cancelHalfRunPlans — разовая отмена недоведённых прежних групп', () => {
  let dir = '';
  let store: AppStore;
  const NOW = '2026-11-02T08:00:00.000Z';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-cancel-half-run-'));
    store = new AppStore(dir);
    store.setSplitPlan(plan('running', ['done', 'started']));
    store.setSplitPlan(plan('empty', []));
    store.setSplitPlan(plan('finished', ['done', 'failed']));
    store.setSplitPlan(plan('human', ['paused'], { cancelledAt: '2026-10-20T00:00:00.000Z' }));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('отменяет только недоведённые: доведённые и отменённые человеком не трогает', () => {
    expect(cancelHalfRunPlans(store, NOW).plans.sort()).toEqual(['empty', 'running']);
    const plans = store.getSplitPlans();
    expect(plans.running?.cancelledAt).toBe(NOW);
    expect(plans.empty?.cancelledAt).toBe(NOW);
    expect(plans.finished?.cancelledAt).toBeUndefined();
    expect(plans.human?.cancelledAt).toBe('2026-10-20T00:00:00.000Z');
  });

  it('после миграции страница видит запуск остановленным, а не «не доведён»', () => {
    cancelHalfRunPlans(store, NOW);
    const states = Object.fromEntries(
      legacyGroupRuns(store.getSplitPlans()).map((run) => [run.parentChatId, run.state]),
    );
    expect(states).toEqual({
      running: 'cancelled',
      empty: 'cancelled',
      finished: 'finished',
      human: 'cancelled',
    });
  });

  it('идемпотентна: второй старт (новое хранилище над тем же каталогом) ничего не меняет', () => {
    cancelHalfRunPlans(store, NOW);
    const reopened = new AppStore(dir);
    expect(reopened.getSplitPlans().running?.cancelledAt).toBe(NOW);
    expect(cancelHalfRunPlans(reopened, '2026-11-03T00:00:00.000Z').plans).toEqual([]);
    expect(reopened.getSplitPlans().running?.cancelledAt).toBe(NOW);
  });

  it('отзывает ждущие D-n групп, вопросы одиночных чатов не трогает; второй старт — пусто', () => {
    const file = join(dir, DEFERRED_ASKS_FILE);
    const asks = new DeferredAsks({ file });
    const call = (scope: Parameters<DeferredAsks['ask']>[0]['scope'], command: string) =>
      asks.ask({ scope, runKeys: ['k'], toolName: 'Bash', input: { command }, reason: 'r' });
    call({ kind: 'group', parentChatId: 'running', groupIndex: 1 }, 'git push origin b1');
    call({ kind: 'chat', chatKeys: ['solo'] }, 'psql -c "DROP TABLE t"');
    expect(cancelHalfRunPlans(store, NOW, asks).asks).toHaveLength(1);
    const reread = new DeferredAsks({ file });
    expect(reread.all().map((record) => [record.scope.kind, record.state])).toEqual([
      ['group', 'withdrawn'],
      ['chat', 'waiting'],
    ]);
    expect(cancelHalfRunPlans(new AppStore(dir), NOW, reread)).toEqual({ plans: [], asks: [] });
  });
});
