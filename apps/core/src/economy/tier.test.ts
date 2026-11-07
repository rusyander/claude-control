import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import type { Route } from '@agentdeck/contracts/core/routes';
import { describe, expect, it } from 'vitest';
import { decideTier, lowerModel, modelMatches, overrideFor } from './tier.ts';
import type { AllowedRoute, OverrideRow, TierInput, TierLadder } from './tier.types.ts';
import { DEFERRABLE } from './window/index.ts';

/**
 * Судья `tier` (G7, 03 §Economy, P80 строка tier): выбор только внутри разрешённого набора;
 * правка шага уже единицы, единицы уже задачи; отказ называет каждое невыполненное условие.
 * v2: уровень сценария (подъём усилия плана, понижение механики), ревьюер не слабее автора
 * (P35), подписка раньше платного (P117), окно держит маршрут — он пропущен, остальные годные
 * названы кандидатами подмены (P110), реестр маршрутов (`ofKind`/`require`).
 */

const TASK = '01920000-0000-7000-8000-0000000000a1';
const UNIT = '01920000-0000-7000-8000-0000000000b1';
const STEP = '01920000-0000-7000-8000-0000000000c1';

const LOGIN: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'cli-login', id: 'cli-login-claude' },
  modelPattern: 'claude-*',
};
const KEY: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'api-key', id: 'anthropic-key' },
  modelPattern: 'claude-*',
};
const LOGIN_ANY: AllowedRoute = { ...LOGIN, modelPattern: '*' };
const QWEN: AllowedRoute = {
  adapter: 'qwen',
  route: { kind: 'local', id: 'local-own' },
  modelPattern: 'qwen3-coder',
};

/** Лестница — данные переходника (P108): имена только в тесте. */
const LADDER: TierLadder = {
  models: ['claude-haiku', 'claude-sonnet', 'claude-opus'],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
};
const LADDERS = { claude: LADDER };

const input = (over: Partial<TierInput> = {}): TierInput => ({
  taskId: TASK,
  unitId: UNIT,
  stepId: STEP,
  stepModel: { tier: 'ceiling' },
  allowed: [KEY, LOGIN, QWEN],
  ceiling: null,
  overrides: [],
  ...over,
});

let seq = 10;
const row = (
  scope: OverrideRow['scope'],
  field: OverrideRow['field'],
  value: string | null,
): OverrideRow => ({
  seq: (seq += 1),
  scope,
  scopeId: { task: TASK, unit: UNIT, step: STEP }[scope],
  field,
  value,
  timing: 'safe-point',
});

const held = (routeId: string, verdict: WindowDecision['verdict'] = 'held'): WindowDecision => ({
  routeId,
  limitKind: 'window',
  verdict,
  // Как пишет `decideWindow`: `held` откладывает только откладываемые классы.
  defer: verdict === 'held' ? [...DEFERRABLE] : [],
  resumeAt: null,
  reasons: [],
});

describe('G7 decideTier', () => {
  it('no override: the own CLI login before the paid key; pattern exactly * → CLI default model', () => {
    const got = decideTier(input({ allowed: [KEY, LOGIN_ANY, QWEN] }));
    expect(got).toMatchObject({
      ok: true,
      adapter: 'claude',
      route: LOGIN.route,
      model: null,
      effort: null,
      sources: { adapter: 'route', model: 'cli-default', effort: 'cli-default' },
      asked: 'ceiling',
      applied: 'ceiling',
      learning: 'counted',
      basis: 'modelled',
    });
  });

  it('a partial wildcard never takes the CLI default: compat could not prove the model inside it', () => {
    expect(decideTier(input({ allowed: [KEY, LOGIN] }))).toMatchObject({
      ok: false,
      reasons: ['no model named: a pattern other than * needs a model override or a task ceiling'],
      dropped: [],
      skipped: [],
      alternatives: [],
      basis: 'modelled',
    });
    expect(decideTier(input({ allowed: [KEY, LOGIN, QWEN] }))).toMatchObject({
      ok: true,
      adapter: 'qwen',
      model: 'qwen3-coder',
    });
  });

  it('the task ceiling is used when the pattern admits it; a literal pattern names its model', () => {
    expect(decideTier(input({ ceiling: 'claude-opus-5' }))).toMatchObject({
      model: 'claude-opus-5',
      sources: { model: 'ceiling' },
    });
    expect(decideTier(input({ allowed: [QWEN] }))).toMatchObject({
      adapter: 'qwen',
      model: 'qwen3-coder',
      sources: { model: 'route' },
    });
  });

  it('step > unit > task; the latest line of a level wins; a null line clears only its own level', () => {
    const task = row('task', 'model', 'claude-haiku-5');
    const unit = row('unit', 'model', 'claude-sonnet-5');
    expect(decideTier(input({ overrides: [task, unit] }))).toMatchObject({
      model: 'claude-sonnet-5',
      sources: { model: 'override-unit' },
      learning: 'override',
    });
    const step = row('step', 'model', 'claude-opus-5');
    expect(decideTier(input({ overrides: [task, unit, step] }))).toMatchObject({
      model: 'claude-opus-5',
      sources: { model: 'override-step' },
    });
    const cleared = row('step', 'model', null);
    expect(decideTier(input({ overrides: [task, unit, step, cleared] }))).toMatchObject({
      model: 'claude-sonnet-5',
    });
    expect(
      overrideFor([task, unit], 'model', { taskId: TASK, unitId: null, stepId: null }),
    ).toEqual({ value: 'claude-haiku-5', source: 'override-task' });
  });

  it('effort: override, else the step, else the CLI', () => {
    expect(decideTier(input({ stepModel: { tier: 'ceiling', effort: 'high' } }))).toMatchObject({
      effort: 'high',
      sources: { effort: 'step' },
    });
    expect(
      decideTier(
        input({
          stepModel: { tier: 'ceiling', effort: 'high' },
          overrides: [row('task', 'effort', 'low')],
        }),
      ),
    ).toMatchObject({ effort: 'low', sources: { effort: 'override-task' } });
  });

  it('adapter override picks among its own routes; outside the set → refused with every reason', () => {
    expect(decideTier(input({ overrides: [row('unit', 'adapter', 'qwen')] }))).toMatchObject({
      ok: true,
      adapter: 'qwen',
      sources: { adapter: 'override-unit' },
    });
    const both = decideTier(
      input({
        allowed: [LOGIN],
        overrides: [row('task', 'adapter', 'codex'), row('task', 'model', 'gpt-6')],
      }),
    );
    expect(both).toMatchObject({
      ok: false,
      reasons: [
        'adapter codex (override-task) is not in the allowed set',
        'model gpt-6 (override-task) matches no allowed route pattern',
      ],
      dropped: [],
      basis: 'modelled',
    });
    const model = decideTier(
      input({ allowed: [LOGIN, QWEN], overrides: [row('step', 'model', 'gpt-6')] }),
    );
    expect(model).toMatchObject({
      ok: false,
      reasons: ['model gpt-6 (override-step) matches no allowed route pattern'],
    });
  });

  it('step routes narrow the task set; a step route outside it is dropped and named, never added', () => {
    const outside: AllowedRoute = { ...QWEN, route: { kind: 'gateway', id: 'corp' } };
    const got = decideTier(
      input({
        allowed: [KEY, LOGIN],
        ceiling: 'claude-opus-5',
        stepModel: { tier: 'ceiling', routes: [KEY, outside] },
      }),
    );
    expect(got).toMatchObject({ ok: true, route: KEY.route, dropped: [outside] });
    expect(got.reasons[0]).toBe(
      "step route qwen/gateway:corp/qwen3-coder is outside the task's allowed set",
    );
    expect(decideTier(input({ allowed: [], stepModel: { tier: 'ceiling' } }))).toMatchObject({
      ok: false,
      reasons: ['no allowed route for this step'],
    });
  });

  it('modelMatches: star is any run, no star is exact, regex characters are literal', () => {
    expect(modelMatches('claude-*', 'claude-opus-5')).toBe(true);
    expect(modelMatches('claude-*', 'gpt-claude-1')).toBe(false);
    expect(modelMatches('a.b', 'axb')).toBe(false);
    expect(modelMatches('qwen3-coder', 'qwen3-coder')).toBe(true);
  });

  it('registry: a route the registry does not know is never chosen; the chosen one reads its caps', () => {
    // Реестр знает только вход CLI: ключ API набора назван и не выбран, числа читают caps.
    const route = { caps: { offline: false } } as unknown as Route;
    const registry = {
      ofKind: (kind: string) =>
        kind === 'cli-login' ? [{ ...route, id: 'cli-login-claude', kind }] : [],
      require: () => route,
    } as unknown as TierInput['registry'];
    const got = decideTier(input({ allowed: [KEY, LOGIN], ceiling: 'claude-opus-5', registry }));
    expect(got).toMatchObject({ ok: true, route: LOGIN.route, dropped: [KEY] });
    expect(got.reasons).toContain(
      'route claude/api-key:anthropic-key/claude-* is not in the route registry',
    );
    expect(got.numbers).toMatchObject({ offline: 0, dropped: 1 });
  });
});

/**
 * Таблица уровня сценария (план s5 §7 E «model test tier»): уровень × правка × окно × выученное.
 * Каждая строка — один исход; строки с правкой человека показывают, что уровень её не трогает.
 */
describe('G7 tier table: scenario tier × override × window × learned', () => {
  const base = { ceiling: 'claude-opus-5', ladders: LADDERS, allowed: [LOGIN] };
  const rows: {
    name: string;
    over: Partial<TierInput>;
    want: Record<string, unknown>;
  }[] = [
    {
      name: 'raise-for-planning on a plan step → effort xhigh, never max',
      over: { stepModel: { tier: 'raise-for-planning', effort: 'medium' }, stepKind: 'plan' },
      want: { effort: 'xhigh', applied: 'raised', sources: { effort: 'tier' } },
    },
    {
      name: 'raise-for-planning on a work step → no raise',
      over: { stepModel: { tier: 'raise-for-planning', effort: 'medium' }, stepKind: 'work' },
      want: { effort: 'medium', applied: 'ceiling' },
    },
    {
      name: 'raise-for-planning under an effort override → the override stays',
      over: {
        stepModel: { tier: 'raise-for-planning' },
        stepKind: 'research',
        overrides: [row('step', 'effort', 'low')],
      },
      want: { effort: 'low', applied: 'ceiling', learning: 'override' },
    },
    {
      name: 'lower-if-mechanical with mid checks → one rung lower',
      over: {
        stepModel: { tier: 'lower-if-mechanical' },
        stepKind: 'work',
        stepChecks: { mid: 'narrow', required: [] },
      },
      want: { model: 'claude-sonnet', applied: 'lowered', sources: { model: 'tier' } },
    },
    {
      name: 'lower-if-mechanical without mid checks → ceiling',
      over: {
        stepModel: { tier: 'lower-if-mechanical' },
        stepKind: 'work',
        stepChecks: { mid: 'none', required: [] },
      },
      want: { model: 'claude-opus-5', applied: 'ceiling' },
    },
    {
      name: 'lower-if-mechanical after a failure at the lower tier → redo at ceiling',
      over: { stepModel: { tier: 'lower-if-mechanical' }, stepKind: 'work', lowerFailedHere: true },
      want: { model: 'claude-opus-5', applied: 'ceiling' },
    },
    {
      name: 'lower-if-mechanical on a review step → never lowered',
      over: { stepModel: { tier: 'lower-if-mechanical' }, stepKind: 'review' },
      want: { model: 'claude-opus-5', applied: 'ceiling' },
    },
    {
      name: 'lower-if-mechanical under a model override → the override stays',
      over: {
        stepModel: { tier: 'lower-if-mechanical' },
        stepKind: 'work',
        overrides: [row('unit', 'model', 'claude-opus-6')],
      },
      want: { model: 'claude-opus-6', applied: 'ceiling', learning: 'override' },
    },
    {
      name: 'window holds the login route, key allowed with paid on refusal → key',
      over: { allowed: [KEY, LOGIN], windows: [held('cli-login-claude')], paidOnRefusal: true },
      want: { route: KEY.route, skipped: [{ route: LOGIN, verdict: 'held' }] },
    },
    {
      // `held` не откладывает фикс (03:157-160): фикс идёт на вход, ключ не нужен.
      name: 'window holds the login route but the step is a fix → login, nothing skipped',
      over: { allowed: [KEY, LOGIN], windows: [held('cli-login-claude')], stepClass: 'fix' },
      want: { route: LOGIN.route, skipped: [] },
    },
    {
      name: 'refused login holds a fix step too → key with paid on refusal',
      over: {
        allowed: [KEY, LOGIN],
        windows: [held('cli-login-claude', 'refused')],
        stepClass: 'fix',
        paidOnRefusal: true,
      },
      want: { route: KEY.route, skipped: [{ route: LOGIN, verdict: 'refused' }] },
    },
  ];
  for (const r of rows)
    it(r.name, () => {
      const got = decideTier(input({ ...base, ...r.over }));
      expect(got).toMatchObject({ ok: true, ...r.want });
    });

  it('lowerModel walks down inside the route pattern only', () => {
    expect(lowerModel(LADDER, 'claude-opus-5', 'claude-*')).toBe('claude-sonnet');
    expect(lowerModel(LADDER, 'claude-opus-5', 'claude-opus*')).toBeNull();
    expect(lowerModel(LADDER, 'claude-haiku-5', 'claude-*')).toBeNull();
    expect(lowerModel(undefined, 'claude-opus-5', 'claude-*')).toBeNull();
  });
});

describe('G7 effort never max: the core never picks max itself, only a user override may', () => {
  it('a step asking max is clamped to the raise cap; a user override of max stays', () => {
    const step = decideTier(
      input({
        ceiling: 'claude-opus-5',
        ladders: LADDERS,
        stepModel: { tier: 'ceiling', effort: 'max' },
      }),
    );
    expect(step).toMatchObject({ ok: true, effort: 'xhigh', sources: { effort: 'tier' } });
    const user = decideTier(
      input({
        ceiling: 'claude-opus-5',
        ladders: LADDERS,
        overrides: [row('task', 'effort', 'max')],
      }),
    );
    expect(user).toMatchObject({ ok: true, effort: 'max', sources: { effort: 'override-task' } });
  });

  it('raise-for-planning on a ladder whose top is max stops at xhigh', () => {
    for (const kind of ['plan', 'split', 'research']) {
      const got = decideTier(
        input({
          ceiling: 'claude-opus-5',
          ladders: LADDERS,
          stepKind: kind,
          stepModel: { tier: 'raise-for-planning' },
        }),
      );
      expect(got).toMatchObject({ ok: true, effort: 'xhigh' });
    }
  });
});

describe('P35 reviewer ≥ author: raised to the author, or one warning on a user override', () => {
  const review = (over: Partial<TierInput>): TierInput =>
    input({
      ladders: LADDERS,
      allowed: [LOGIN],
      stepKind: 'review',
      author: { adapter: 'claude', model: 'claude-opus-5', effort: 'high' },
      ...over,
    });

  it('a reviewer weaker than the author is raised to the author model and effort', () => {
    const got = decideTier(
      review({ ceiling: 'claude-sonnet-5', stepModel: { tier: 'ceiling', effort: 'low' } }),
    );
    expect(got).toMatchObject({
      ok: true,
      model: 'claude-opus-5',
      effort: 'high',
      sources: { model: 'author', effort: 'author' },
      warnings: [],
    });
    expect(got.reasons).toContain(
      'reviewer raised to the author: model claude-sonnet-5 < claude-opus-5, effort low < high',
    );
  });

  it('a user override below the author wins with exactly one warning', () => {
    const got = decideTier(
      review({
        ceiling: 'claude-opus-5',
        overrides: [row('step', 'model', 'claude-haiku-5'), row('step', 'effort', 'low')],
      }),
    );
    expect(got).toMatchObject({
      ok: true,
      model: 'claude-haiku-5',
      effort: 'low',
      learning: 'override',
      warnings: [
        'reviewer below author by user override: model claude-haiku-5 < claude-opus-5, effort low < high',
      ],
    });
  });

  it('a reviewer at or above the author is left alone, no warning', () => {
    const got = decideTier(
      review({ ceiling: 'claude-opus-5', stepModel: { tier: 'ceiling', effort: 'xhigh' } }),
    );
    expect(got).toMatchObject({ ok: true, model: 'claude-opus-5', effort: 'xhigh', warnings: [] });
  });

  it("the author's model outside the reviewer route pattern → refused, never a weaker review", () => {
    const sonnetOnly: AllowedRoute = { ...LOGIN, modelPattern: 'claude-sonnet*' };
    const got = decideTier(review({ allowed: [sonnetOnly], ceiling: 'claude-sonnet-5' }));
    expect(got).toMatchObject({ ok: false });
    expect(got.reasons[0]).toBe(
      "reviewer cannot reach the author's model claude-opus-5 on claude/cli-login:cli-login-claude/claude-sonnet*",
    );
  });
});

describe('P117 subscription before paid: a window refusing the CLI login never moves to the key unasked', () => {
  const table: {
    name: string;
    windows: WindowDecision[];
    paid: boolean | undefined;
    want: { ok: boolean; route?: AllowedRoute['route'] };
  }[] = [
    {
      name: 'login open → login',
      windows: [],
      paid: undefined,
      want: { ok: true, route: LOGIN.route },
    },
    {
      name: 'login open, paid on → still login',
      windows: [],
      paid: true,
      want: { ok: true, route: LOGIN.route },
    },
    {
      name: 'login held, paid off → refused',
      windows: [held('cli-login-claude')],
      paid: undefined,
      want: { ok: false },
    },
    {
      name: 'login exhausted, paid off → refused',
      windows: [held('cli-login-claude', 'exhausted')],
      paid: false,
      want: { ok: false },
    },
    {
      name: 'login held, paid on → key',
      windows: [held('cli-login-claude')],
      paid: true,
      want: { ok: true, route: KEY.route },
    },
    {
      name: 'login refused, paid off → refused',
      windows: [held('cli-login-claude', 'refused')],
      paid: undefined,
      want: { ok: false },
    },
    {
      name: 'login offline, paid off → refused',
      windows: [held('cli-login-claude', 'offline')],
      paid: undefined,
      want: { ok: false },
    },
    {
      name: 'login only warned → login',
      windows: [held('cli-login-claude', 'warn')],
      paid: undefined,
      want: { ok: true, route: LOGIN.route },
    },
    {
      name: 'key held, login open → login',
      windows: [held('anthropic-key')],
      paid: undefined,
      want: { ok: true, route: LOGIN.route },
    },
  ];
  for (const t of table)
    it(t.name, () => {
      const got = decideTier(
        input({
          allowed: [KEY, LOGIN],
          ceiling: 'claude-opus-5',
          windows: t.windows,
          paidOnRefusal: t.paid,
        }),
      );
      expect(got).toMatchObject(t.want);
      if (!t.want.ok)
        expect(got.reasons).toEqual([
          'every allowed route of this step is held or blocked',
          `route claude/cli-login:cli-login-claude/claude-* skipped: window ${t.windows[0]?.verdict}`,
          'route claude/api-key:anthropic-key/claude-* not taken: paid on refusal is off for this task',
        ]);
    });

  it('the key is listed after the login even when the key comes first in the set', () => {
    expect(decideTier(input({ allowed: [KEY, LOGIN], ceiling: 'claude-opus-5' }))).toMatchObject({
      route: LOGIN.route,
      alternatives: [KEY],
    });
  });
});

describe('P110 alternatives: other usable routes are named in cost order, held ones never', () => {
  it('chosen first, the rest in order; a held route is skipped, not an alternative', () => {
    const local: AllowedRoute = {
      adapter: 'claude',
      route: { kind: 'local', id: 'llama' },
      modelPattern: 'claude-*',
    };
    const got = decideTier(
      input({
        allowed: [KEY, LOGIN, local],
        ceiling: 'claude-opus-5',
        windows: [held('llama')],
      }),
    );
    expect(got).toMatchObject({
      ok: true,
      route: LOGIN.route,
      alternatives: [KEY],
      skipped: [{ route: local, verdict: 'held' }],
      numbers: { allowed: 3, skipped: 1, alternatives: 1 },
    });
  });
});
