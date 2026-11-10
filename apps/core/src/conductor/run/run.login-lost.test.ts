import { describe, expect, it } from 'vitest';
import type { JournalDataV1, JournalLine } from '@agentdeck/contracts/core/journal';
import type { Scenario } from '@agentdeck/contracts/core/scenario';
import { readJournalLines } from '../../journal/read-lines.ts';
import { loginKey } from '../human/login-ask.ts';
import { CONDUCTOR_ANSWERS } from '../next/answers.ts';
import { presetStep } from '../scenario/presets.ts';
import { openAsk, ROUTE, stand, type Stand } from './__fixtures__/run-harness.ts';
import type { LoginState } from './run.types.ts';

/**
 * Потерянный вход CLI посреди шага (этап 12, P170) на настоящем цикле, журнале, подъёме вопроса и
 * команде `answer`; подделаны только сессия модели и чтение входа (хранилище входа CLI — внешняя
 * граница). Ошибка хода с текстом «войдите заново» — подозрение; решает перечитанный вход:
 * «нет» → `route.login-lost` + вопрос пункта 4 (relogin | stop | перевод), сессия снята; «есть» или
 * «неизвестно» — обычный конец хода, без факта и вопроса.
 */

const CODEX: JournalDataV1['task.created']['allowedRoutes'][number] = {
  adapter: 'codex',
  route: { kind: 'stub', id: 'stub-codex' },
  modelPattern: '*',
};

const WORK: Scenario = {
  id: 'login-lost',
  version: 1,
  title: 't',
  steps: [presetStep('work', 'work', 'Работа', [])],
};

const TEXT = 'Not logged in · Please run /login';
const LOGIN = CONDUCTOR_ANSWERS.login.ru;
const lines = (s: Stand): JournalLine[] => readJournalLines(s.dir, s.taskId).lines;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Шаг на входе claude, ход кончается ошибкой «войдите заново»; `reads` — что вернуло чтение. */
async function lostTurn(
  state: LoginState | null,
  over: Pick<NonNullable<Parameters<typeof stand>[1]>, 'routes' | 'modelCeiling'> = {},
): Promise<{ s: Stand; stepId: string; reads: string[] }> {
  const reads: string[] = [];
  const s = await stand(WORK, {
    model: { 'work:0': 'hold' },
    routes: [ROUTE, CODEX],
    ...over,
    journalSessions: true,
    ...(state === null
      ? {}
      : {
          loginState: async (adapter: string, routeId: string) => {
            reads.push(`${adapter}/${routeId}`);
            return state;
          },
        }),
  });
  await s.until(() => s.port.sessions.size === 1);
  const stepId = Object.keys(s.task.state.steps)[0]!;
  const [sess] = [...s.port.sessions.values()];
  sess!.on.loginLost?.(TEXT);
  sess!.on.turnEnded();
  return { s, stepId, reads };
}

describe('login lost mid-step (stage 12, P170)', () => {
  it('re-read absent: route.login-lost fact, ONE point-4 ask (source login) with relogin|stop|cli:codex, session ended', async () => {
    const { s, stepId, reads } = await lostTurn('absent');
    await s.until(() => openAsk(s.task, 'login:') !== undefined);
    expect(reads).toEqual(['claude/claude-login']);
    const fact = lines(s).filter((l) => l.kind === 'route.login-lost');
    expect(fact.map((l) => l.data)).toEqual([{ routeId: 'claude-login', stepId }]);
    expect(s.task.state.loginLost?.[stepId]?.routeId).toBe('claude-login');
    const askId = openAsk(s.task, 'login:')!;
    const ask = s.task.state.asks[askId]!;
    expect(ask).toMatchObject({
      point: 4,
      source: 'login',
      dedupe: loginKey('claude-login', stepId),
    });
    const asked = lines(s).find(
      (l) => l.kind === 'human.asked' && (l.data as { askId: string }).askId === askId,
    )!.data as { options: string[]; question: string; defaultAction: string | null };
    expect(asked.options).toEqual([LOGIN.relogin, LOGIN.stop, 'cli:codex']);
    expect(asked.defaultAction).toBeNull();
    expect(asked.question).toMatch(/потерял вход/);
    await s.until(() => s.port.ends.length === 1);
    expect(s.port.ends[0]!.mode).toBe('tree');
    expect(s.task.state.steps[stepId]?.state).toBe('waiting-human');
    await pause(60);
    expect(Object.values(s.task.state.asks)).toHaveLength(1);
    expect(s.task.state.overrides).toEqual([]);
    await s.stop();
  });

  it('a model only another route of the same CLI carries (no login needed) is offered as model:<id> (review stage 12)', async () => {
    const sonnetLogin = { ...ROUTE, modelPattern: 'claude-sonnet*' };
    const opusLocal = {
      adapter: 'claude',
      route: { kind: 'local' as const, id: 'opus-box' },
      modelPattern: 'claude-opus-5',
    };
    const { s } = await lostTurn('absent', {
      routes: [sonnetLogin, opusLocal, CODEX],
      modelCeiling: 'claude-sonnet-5',
    });
    await s.until(() => openAsk(s.task, 'login:') !== undefined);
    const askId = openAsk(s.task, 'login:')!;
    const asked = lines(s).find(
      (l) => l.kind === 'human.asked' && (l.data as { askId: string }).askId === askId,
    )!.data as { options: string[] };
    expect(asked.options).toEqual([LOGIN.relogin, LOGIN.stop, 'model:claude-opus-5', 'cli:codex']);
    await s.stop();
  });

  it('re-read up: the normal turn-end path — no fact, no ask, the step keeps its session', async () => {
    const { s, stepId, reads } = await lostTurn('up');
    await s.until(() => reads.length === 1);
    await pause(80);
    expect(lines(s).filter((l) => l.kind === 'route.login-lost')).toEqual([]);
    expect(openAsk(s.task, 'login:')).toBeUndefined();
    expect(s.task.state.loginLost?.[stepId]).toBeUndefined();
    expect(s.port.ends).toEqual([]);
    await s.stop();
  });

  it('no re-read port (unknown): the normal path, nothing raised', async () => {
    const { s, stepId } = await lostTurn(null);
    await pause(100);
    expect(lines(s).filter((l) => l.kind === 'route.login-lost')).toEqual([]);
    expect(openAsk(s.task, 'login:')).toBeUndefined();
    expect(s.task.state.loginLost?.[stepId]).toBeUndefined();
    await s.stop();
  });

  it('answer «cli:codex»: an override citing the ask, the next session runs on codex', async () => {
    const { s } = await lostTurn('absent');
    await s.until(() => openAsk(s.task, 'login:') !== undefined);
    const askId = openAsk(s.task, 'login:')!;
    await s.answer(askId, 'cli:codex');
    await s.until(() => s.port.opened.length === 2);
    expect(Object.values(s.task.state.sessions).map((x) => `${x.adapter}/${x.route.id}`)).toEqual([
      'claude/claude-login',
      'codex/stub-codex',
    ]);
    const set = lines(s).filter((l) => l.kind === 'override.set');
    expect(set.map((l) => (l.data as { cmdId: string; value: string }).cmdId)).toEqual([askId]);
    await s.stop();
  });

  it('answer «relogin»: a new session on the same route, no override', async () => {
    const { s } = await lostTurn('absent');
    await s.until(() => openAsk(s.task, 'login:') !== undefined);
    const askId = openAsk(s.task, 'login:')!;
    await s.answer(askId, LOGIN.relogin);
    await s.until(() => s.port.opened.length === 2);
    expect(s.port.opened[1]!.routing?.tier.ok && s.port.opened[1]!.routing.tier.adapter).toBe(
      'claude',
    );
    expect(s.task.state.overrides).toEqual([]);
    await s.stop();
  });

  it('answer «stop»: the step ends, no new session', async () => {
    const { s, stepId } = await lostTurn('absent');
    await s.until(() => openAsk(s.task, 'login:') !== undefined);
    await s.answer(openAsk(s.task, 'login:')!, LOGIN.stop);
    await s.until(() => s.task.state.steps[stepId]?.outcome !== undefined);
    expect(s.port.opened).toHaveLength(1);
    await s.stop();
  });

  it('an offer the ask never made is refused; the ask stays open', async () => {
    const { s } = await lostTurn('absent');
    await s.until(() => openAsk(s.task, 'login:') !== undefined);
    const askId = openAsk(s.task, 'login:')!;
    await s.answer(askId, 'cli:gemini');
    const refused = lines(s).filter((l) => l.kind === 'command.rejected');
    expect(refused.map((l) => (l.data as { code: string }).code)).toEqual(['unknown-option']);
    expect(s.task.state.asks[askId]?.state).toBe('open');
    await s.stop();
  });
});
