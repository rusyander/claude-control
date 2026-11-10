import type { StepDef } from '@agentdeck/contracts/core/scenario';
import type { AllowedRoute } from '../../economy/tier.types.ts';
import { offersOf } from '../../economy/tier-started.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { CONDUCTOR_QUESTIONS, askLangOf, labelOf, optionsOf } from '../next/answers.ts';
import type { HumanPointRaise, LoginState } from '../run/run.types.ts';

/**
 * Потерянный вход CLI посреди шага (этап 12, P170). Переходник узнал в ошибке хода текст своего
 * CLI «войдите заново» (`CliAdapter.loginLost`) — это только подозрение: текст мог прийти из
 * вывода инструмента или от модели. Решает перечитанное состояние входа маршрута (хранилище
 * входа CLI — внешняя граница): «нет» → факт `route.login-lost` и вопрос пункта 4 с вариантами
 * «войти заново» | «остановить» | перевод `model:`/`cli:`; «есть» или «неизвестно» — обычный путь
 * сбоя хода, вопроса нет. Сам шаг маршрут не меняет (P169): перевод — только кликом.
 */

export const loginKey = (routeId: string, stepId: string): string => `login:${routeId}:${stepId}`;

export interface LoginLostInput {
  stepId: string;
  sessionId: string;
  /** Текст ошибки хода (для причины решения; в вопрос не идёт — он мог прийти от модели). */
  text: string;
  /** Шаг сценария: заголовок вопроса на языке задачи. */
  step: Pick<StepDef, 'id' | 'title'>;
}

export interface LoginLostDeps {
  /** Перечитать вход маршрута сессии; нет порта — `unknown`. */
  loginState?: (adapter: string, routeId: string) => Promise<LoginState>;
  raise(r: HumanPointRaise): { kind: string; askId?: string };
  note?(event: string, data: Record<string, unknown>): void;
}

/**
 * Варианты перевода: годные маршруты набора, кроме потерявшего вход (тот же отбор, что у окна).
 * Потерян вход CLI — отпадают только маршруты входа этого CLI; его ключ API или локальный маршрут
 * входа не ждут, и модель, которую несёт только такой маршрут, — вариант `model:` (ревью этапа 12).
 */
function loginOffers(task: LiveTask, adapter: string, routeId: string): string[] {
  const routes = allowedRoutesOf(task.state) as readonly AllowedRoute[];
  const planned = routes.find((r) => r.route.id === routeId && r.adapter === adapter);
  if (!planned) return [];
  const usable = routes.filter(
    (r) => r !== planned && !(r.adapter === adapter && r.route.kind === 'cli-login'),
  );
  return offersOf({ paidOnRefusal: task.state.created?.paidOnRefusal }, planned, usable);
}

/**
 * Итог: `'asked'` — вход перечитан «нет», вопрос поднят (шаг ждёт человека, сессию снимает
 * вызывающий); `'normal'` — обычный конец хода с ошибкой.
 */
export async function settleLoginLost(
  task: LiveTask,
  input: LoginLostInput,
  deps: LoginLostDeps,
): Promise<'asked' | 'normal'> {
  const session = task.state.sessions[input.sessionId];
  const step = task.state.steps[input.stepId];
  if (!session || !step || step.outcome !== undefined) return 'normal';
  const routeId = session.route.id;
  let state: LoginState;
  try {
    state = deps.loginState ? await deps.loginState(session.adapter, routeId) : 'unknown';
  } catch {
    state = 'unknown';
  }
  deps.note?.('login.reread', { stepId: input.stepId, routeId, state });
  if (state !== 'absent') return 'normal';
  // Пока шли перечитывать, шаг мог кончиться или уже спросить: второго вопроса нет.
  const now = task.state.steps[input.stepId];
  if (!now || now.outcome !== undefined) return 'normal';
  task.append({
    kind: 'route.login-lost',
    actor: 'core',
    stepId: input.stepId,
    sessionId: input.sessionId,
    data: { routeId, stepId: input.stepId },
  });
  const lang = askLangOf(task.state);
  const offers = loginOffers(task, session.adapter, routeId);
  deps.raise({
    source: 'login',
    stepId: input.stepId,
    sessionId: null,
    action: null,
    point: 4,
    dedupe: loginKey(routeId, input.stepId),
    question: CONDUCTOR_QUESTIONS.login(lang, routeId, input.step, offers.length),
    options: [...optionsOf('login', lang), ...offers],
    recommendation: labelOf('login', lang, 'relogin'),
    blocking: true,
  });
  return 'asked';
}
