import type { WindowDecision } from '@agentdeck/contracts/core/economy';
import { describe, expect, it } from 'vitest';
import { decideTier } from './tier.ts';
import { tierDecisionBody } from './records.ts';
import type { AllowedRoute, TierInput } from './tier.types.ts';
import { DEFERRABLE } from './window/index.ts';

/**
 * Судья `tier` у начатой задачи (этап 12, P169, D19). Владелец: «подождать сброса или другая
 * модель — только по клику». Первая сессия выбирает внутри набора, как раньше (P110, P117 —
 * `tier.test.ts`); после неё окно маршрут не двигает: плановый маршрут (выбор без окон) ждёт, а
 * годные маршруты — только варианты клика `offers`. Заранее разрешён один переход: ключ API того
 * же CLI при «платном при отказе» задачи (P117).
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
const CODEX: AllowedRoute = {
  adapter: 'codex',
  route: { kind: 'cli-login', id: 'cli-login-codex' },
  modelPattern: '*',
};
const GEMINI_KEY: AllowedRoute = {
  adapter: 'gemini',
  route: { kind: 'api-key', id: 'google-key' },
  modelPattern: '*',
};
const SONNET_LOGIN: AllowedRoute = { ...LOGIN, modelPattern: 'claude-sonnet*' };
const OPUS_LOCAL: AllowedRoute = {
  adapter: 'claude',
  route: { kind: 'local', id: 'opus-box' },
  modelPattern: 'claude-opus-5',
};

const held = (routeId: string, verdict: WindowDecision['verdict'] = 'held'): WindowDecision => ({
  routeId,
  limitKind: 'window',
  verdict,
  defer: verdict === 'held' ? [...DEFERRABLE] : [],
  resumeAt: null,
  reasons: [],
});

const input = (over: Partial<TierInput> = {}): TierInput => ({
  taskId: TASK,
  unitId: UNIT,
  stepId: STEP,
  stepModel: { tier: 'ceiling' },
  allowed: [LOGIN, CODEX],
  ceiling: 'claude-opus-5',
  overrides: [],
  ...over,
});

describe('P169 started task: a window never moves route, model or CLI without a click', () => {
  it('first session (not started): the held login is skipped, codex is taken (P110 unchanged)', () => {
    const got = decideTier(input({ windows: [held('cli-login-claude', 'refused')] }));
    expect(got).toMatchObject({ ok: true, adapter: 'codex', started: false });
  });

  it('started: the held login is waited for, codex is only offered', () => {
    const got = decideTier(
      input({ windows: [held('cli-login-claude', 'refused')], started: true }),
    );
    expect(got).toMatchObject({
      ok: false,
      started: true,
      waits: { route: LOGIN, verdict: 'refused' },
      offers: ['cli:codex'],
      alternatives: [CODEX],
    });
    expect(got.reasons[0]).toBe(
      'route claude/cli-login:cli-login-claude/claude-* window refused: a started task waits for it and never switches route, model or CLI without a click (P169)',
    );
  });

  it('started, planned route open: the usual choice, marked started', () => {
    const got = decideTier(input({ windows: [held('cli-login-codex', 'refused')], started: true }));
    expect(got).toMatchObject({ ok: true, route: LOGIN.route, started: true });
  });

  it('started, paid on refusal on: the same CLI key is taken (pre-authorised by P117)', () => {
    const got = decideTier(
      input({
        allowed: [LOGIN, KEY, CODEX],
        windows: [held('cli-login-claude', 'exhausted')],
        paidOnRefusal: true,
        started: true,
      }),
    );
    expect(got).toMatchObject({ ok: true, route: KEY.route, adapter: 'claude' });
    expect(got.reasons).toContain(
      'route claude/api-key:anthropic-key/claude-* taken: paid on refusal is on for this task (P117)',
    );
  });

  it('started, paid off: a key of another CLI is never offered; paid on — it is', () => {
    const off = decideTier(
      input({
        allowed: [LOGIN, GEMINI_KEY],
        windows: [held('cli-login-claude', 'refused')],
        started: true,
      }),
    );
    expect(off).toMatchObject({ ok: false, offers: [] });
    const on = decideTier(
      input({
        allowed: [LOGIN, GEMINI_KEY],
        windows: [held('cli-login-claude', 'refused')],
        paidOnRefusal: true,
        started: true,
      }),
    );
    expect(on).toMatchObject({ ok: false, offers: ['cli:gemini'] });
  });

  it('started: a model only another route of the same CLI carries is offered as model:<id>', () => {
    const got = decideTier(
      input({
        allowed: [SONNET_LOGIN, OPUS_LOCAL],
        ceiling: 'claude-sonnet-5',
        windows: [held('cli-login-claude', 'refused')],
        started: true,
      }),
    );
    expect(got).toMatchObject({ ok: false, offers: ['model:claude-opus-5'] });
  });

  it('started: a model the other route does not serve is never offered; unknown list keeps the offer', () => {
    const over = {
      allowed: [SONNET_LOGIN, OPUS_LOCAL],
      ceiling: 'claude-sonnet-5',
      windows: [held('cli-login-claude', 'refused')],
      started: true,
    };
    const lists: Record<string, readonly string[] | null> = { 'opus-box': ['claude-haiku-5'] };
    const absent = decideTier(input({ ...over, servedModels: (id) => lists[id] ?? null }));
    expect(absent).toMatchObject({ ok: false, offers: [] });
    lists['opus-box'] = ['claude-opus-5'];
    const served = decideTier(input({ ...over, servedModels: (id) => lists[id] ?? null }));
    expect(served).toMatchObject({ ok: false, offers: ['model:claude-opus-5'] });
    const unknown = decideTier(input({ ...over, servedModels: () => null }));
    expect(unknown).toMatchObject({ ok: false, offers: ['model:claude-opus-5'] });
  });

  it('started on codex (its last session): claude open again — the step stays on codex', () => {
    const got = decideTier(input({ started: true, startedOn: CODEX }));
    expect(got).toMatchObject({ ok: true, adapter: 'codex', route: CODEX.route });
    expect(got.reasons).toContain(
      'route codex/cli-login:cli-login-codex/* kept: a started task stays on the route of its session (P169)',
    );
  });

  it('started on codex, claude still refused, codex open — codex runs, nothing waits for claude', () => {
    const got = decideTier(
      input({ windows: [held('cli-login-claude', 'refused')], started: true, startedOn: CODEX }),
    );
    expect(got).toMatchObject({ ok: true, adapter: 'codex' });
  });

  it('started on codex, codex refused, claude open — waits for codex, claude only offered', () => {
    const got = decideTier(
      input({ windows: [held('cli-login-codex', 'refused')], started: true, startedOn: CODEX }),
    );
    expect(got).toMatchObject({
      ok: false,
      waits: { route: CODEX, verdict: 'refused' },
      offers: ['cli:claude'],
    });
  });

  it('started on the key (paid on refusal), the login of the same CLI open — back to the login (P117)', () => {
    const got = decideTier(
      input({ allowed: [LOGIN, KEY, CODEX], paidOnRefusal: true, started: true, startedOn: KEY }),
    );
    expect(got).toMatchObject({ ok: true, route: LOGIN.route });
  });

  it('started on a route the set override moved away from — the usual choice inside the override', () => {
    const got = decideTier(
      input({
        started: true,
        startedOn: CODEX,
        overrides: [
          {
            seq: 1,
            scope: 'task',
            scopeId: TASK,
            timing: 'now',
            field: 'adapter',
            value: 'claude',
          },
        ],
      }),
    );
    expect(got).toMatchObject({ ok: true, adapter: 'claude' });
  });

  it('the journal row carries started, the waited route and the offers', () => {
    const got = decideTier(
      input({ windows: [held('cli-login-claude', 'refused')], started: true }),
    );
    expect(tierDecisionBody(got).output).toMatchObject({
      refused: true,
      started: true,
      waits: 'claude/cli-login:cli-login-claude',
      offers: ['cli:codex'],
      alternatives: ['codex/cli-login:cli-login-codex'],
    });
  });
});
