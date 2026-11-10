import { describe, expect, it } from 'vitest';
import { decideTier } from './tier.ts';
import type { AllowedRoute, TierInput } from './tier.types.ts';

/**
 * Суд `tier` второго ревью (этап 12, P185): `avoidAdapter` — CLI первого ревьюера. Его маршруты
 * выбор пропускает и называет, решение несёт число `avoided`; других в наборе нет — отказ, правка
 * человека на исключённый CLI — отказ с той же причиной; начатая задача не держит его как плановый.
 */

const TASK = '01920000-0000-7000-8000-0000000000a1';
const UNIT = '01920000-0000-7000-8000-0000000000b1';
const STEP = '01920000-0000-7000-8000-0000000000c1';

const CLAUDE: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'claude-login' },
  modelPattern: '*',
};
const CLAUDE_KEY: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'api-key', id: 'anthropic-key' },
  modelPattern: '*',
};
const CODEX: AllowedRoute = {
  adapter: 'codex',
  route: { kind: 'cli-login', id: 'codex-login' },
  modelPattern: '*',
};

const input = (over: Partial<TierInput> = {}): TierInput => ({
  taskId: TASK,
  unitId: UNIT,
  stepId: STEP,
  stepModel: { tier: 'ceiling' },
  stepKind: 'review',
  allowed: [CLAUDE, CLAUDE_KEY, CODEX],
  ceiling: null,
  overrides: [],
  ...over,
});

describe('stage 12 tier: avoidAdapter keeps the cross review off the first reviewer CLI (P185)', () => {
  it('claude avoided: codex chosen, every claude route named, numbers.avoided counts them', () => {
    const d = decideTier(input({ avoidAdapter: 'claude' }));
    expect(d).toMatchObject({ ok: true, adapter: 'codex', route: CODEX.route });
    expect(d.numbers.avoided).toBe(2);
    expect(d.reasons).toContain(
      "route claude/cli-login:claude-login/* avoided: avoidAdapter claude is the first reviewer's, the cross review runs on another adapter",
    );
    expect(d.alternatives).toEqual([]);
  });

  it('no avoidAdapter: the cheapest route as before, no avoided number', () => {
    const d = decideTier(input());
    expect(d).toMatchObject({ ok: true, adapter: 'claude' });
    expect('avoided' in d.numbers).toBe(false);
  });

  it('only the avoided CLI in the set: refused, the reason names avoidAdapter', () => {
    const d = decideTier(input({ allowed: [CLAUDE, CLAUDE_KEY], avoidAdapter: 'claude' }));
    expect(d.ok).toBe(false);
    expect(d.reasons[0]).toBe(
      'no allowed route on an adapter other than avoidAdapter claude for this step',
    );
    expect(d.numbers.avoided).toBe(2);
  });

  it('a human CLI override on the avoided adapter is refused, never accepted', () => {
    const d = decideTier(
      input({
        avoidAdapter: 'claude',
        overrides: [
          {
            seq: 3,
            field: 'adapter',
            scope: 'task',
            scopeId: TASK,
            value: 'claude',
            timing: 'now',
          },
        ],
      }),
    );
    expect(d.ok).toBe(false);
    expect(d.reasons[0]).toBe(
      "adapter claude (override-task) is avoidAdapter: the cross review never runs on the first reviewer's adapter",
    );
  });

  it('a started task whose last session is the first review: the planned route moves to the other CLI, no wait', () => {
    const d = decideTier(
      input({
        avoidAdapter: 'claude',
        started: true,
        startedOn: { adapter: 'claude', route: CLAUDE.route },
      }),
    );
    expect(d).toMatchObject({ ok: true, adapter: 'codex', started: true });
  });

  it('the author on claude does not lift the cross reviewer to a claude model', () => {
    const d = decideTier(
      input({
        avoidAdapter: 'claude',
        author: { adapter: 'claude', model: 'claude-opus', effort: null },
      }),
    );
    expect(d).toMatchObject({ ok: true, adapter: 'codex', model: null });
  });
});
