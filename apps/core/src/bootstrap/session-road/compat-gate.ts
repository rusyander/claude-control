import type { Fact } from '@agentdeck/contracts/core/facts';
import type {
  AllowedTriple,
  CompatAdapter,
  CompatDecision,
  CompatPolicy,
  CompatRoute,
  FactState,
  ModelFacts,
  Route,
  RouteDecisionRecord,
} from '@agentdeck/contracts/core/routes';
import type { CliAdapter } from '../../adapters/index.ts';
import { allowedRoutesOf } from '../../journal/reduce/fold-view.ts';
import type { LiveTask } from '../../journal/resume.ts';

/**
 * Совместимость до запуска (11 R:PR-05): дорога сессии собирает здесь факты переходника и
 * маршрута, сама зовёт единственного судью `compat` и пишет его решение в журнал записью отсюда —
 * до токена, каталога и процесса. Модуль не отдаёт решений: функция с результатом `CompatDecision`
 * вне `routes/compat` — второй судья (P01). Отказ — ничего не запускается. Разрешённый набор — из
 * свёртки этой задачи (`task.created`, затем `routes.set`; 06 §Precedence), а не из запроса.
 *
 * Обход канала переходник пока не читает — `bypassActive` пуст, и канал с обходом не открыт
 * (fail-closed, P46). Маска и переводы в политике — от хоста звеньев (`hop-link.ts`): решение
 * `via-gateway` дорога проводит через звено шлюза, без хоста переводов нет и судья отказывает.
 */

const stateOf = <T>(fact: Fact<T>): FactState =>
  'value' in fact ? 'value' : 'absent' in fact ? 'absent' : 'unknown';

/** Разрешённый набор сейчас — из свёртки: `routes.set` команды `set-route` поверх `task.created`. */
export function allowedOf(task: LiveTask): AllowedTriple[] {
  return allowedRoutesOf(task.state).map((t) => ({
    adapter: t.adapter,
    route: t.route.id,
    modelPattern: t.modelPattern,
  }));
}

export function compatAdapterOf(adapter: CliAdapter): CompatAdapter {
  const { login, channels, limitsChannel } = adapter.caps;
  return { id: adapter.id, caps: { login, channels, limitsChannel }, bypassActive: {} };
}

export interface CompatFacts {
  route: CompatRoute;
  model: ModelFacts;
  facts: RouteDecisionRecord['facts'];
}

/**
 * Модель по умолчанию CLI (`model: null`) перед судьёй `compat`: `ModelFacts.id = null`, имени
 * ядро не знает; разрешённый набор её пропускает только шаблоном «любая» (судья `compat`).
 * Подаёт её вход самого CLI — свою модель по умолчанию он отдаёт по определению. Контекст модели
 * входа CLI — из документации переходника; окна модели по умолчанию она не называет, поэтому
 * `contextTokens` нет и проверка контекста судьи видит «неизвестно», как у любой модели входа CLI.
 * Маршрут с адресом без модели сюда не доходит: дорога отказывает раньше (`modelRequired`).
 */
export async function compatFactsOf(route: Route, model: string | null): Promise<CompatFacts> {
  if (model === null) return cliDefaultFacts(route);
  const decl = (fact: string) => route.facts.find((f) => f.fact === fact);
  const [availability, credential, models] = await Promise.all([
    route.read.availability(),
    route.read.credential(),
    route.read.models(),
  ]);
  const served = 'value' in models ? models.value.find((m) => m.id === model) : undefined;
  const modelFacts: ModelFacts = {
    id: model,
    served: 'value' in models ? (served ? 'value' : 'absent') : stateOf(models),
    ...(served?.contextTokens !== undefined ? { contextTokens: served.contextTokens } : {}),
    ...(served?.tools !== undefined ? { tools: served.tools } : {}),
  };
  return {
    route: compatRouteOf(route, availability, credential),
    model: modelFacts,
    facts: [
      ...routeFacts(route, availability, credential),
      { readClass: decl('models')?.readClass ?? 'route.models', kind: stateOf(models) },
    ],
  };
}

/** Доступность и доступ маршрута — те же факты при любой модели. */
function compatRouteOf(
  route: Route,
  availability: Fact<unknown>,
  credential: Awaited<ReturnType<Route['read']['credential']>>,
): CompatRoute {
  // Доступ: `none` — маршруту он не нужен; иначе есть/нет, непрочитанный — как факт.
  const decl = (fact: string) => route.facts.find((f) => f.fact === fact);
  const credentialState: CompatRoute['credential'] =
    'value' in credential
      ? credential.value.kind === 'none'
        ? 'none'
        : credential.value.present
          ? 'value'
          : 'absent'
      : stateOf(credential);
  return {
    id: route.id,
    caps: route.caps,
    availability: {
      state: stateOf(availability),
      onUnknown: decl('availability')?.onUnknown ?? 'refuse',
    },
    credential: credentialState,
  };
}

function routeFacts(
  route: Route,
  availability: Fact<unknown>,
  credential: Fact<unknown>,
): RouteDecisionRecord['facts'] {
  const decl = (fact: string) => route.facts.find((f) => f.fact === fact);
  return [
    {
      readClass: decl('availability')?.readClass ?? 'route.availability',
      kind: stateOf(availability),
    },
    { readClass: decl('credential')?.readClass ?? 'route.credential', kind: stateOf(credential) },
  ];
}

/** Модель по умолчанию CLI: список моделей маршрута не читается — выбор не наш. */
async function cliDefaultFacts(route: Route): Promise<CompatFacts> {
  const [availability, credential] = await Promise.all([
    route.read.availability(),
    route.read.credential(),
  ]);
  return {
    route: compatRouteOf(route, availability, credential),
    model: { id: null, served: 'value' },
    facts: routeFacts(route, availability, credential),
  };
}

/** Хоста звеньев нет: маскировать и переводить некому (политику с ним даёт `hop-link.ts`). */
const NO_HOP: Pick<CompatPolicy, 'dlp' | 'translations'> = {
  dlp: { required: false, parses: [] },
  translations: [],
};

/** Всё, что судья `compat` получает от дороги: переходник, факты маршрута и модели, политика. */
export interface CompatInputs {
  adapter: CompatAdapter;
  facts: CompatFacts;
  policy: CompatPolicy;
}

export async function compatInputs(
  task: LiveTask,
  adapter: CliAdapter,
  route: Route,
  model: string | null,
  alternatives: readonly CompatCandidateRef[] = [],
  hop: Pick<CompatPolicy, 'dlp' | 'translations'> = NO_HOP,
): Promise<CompatInputs> {
  return {
    adapter: compatAdapterOf(adapter),
    facts: await compatFactsOf(route, model),
    policy: {
      allowed: allowedOf(task),
      dlp: hop.dlp,
      translations: hop.translations,
      needsTools: true,
      // Кандидаты — запасные тройки суда `tier` (P110), факты каждой прочитаны здесь же тем же
      // чтением, что и у основной: замена с непрочитанными фактами была бы ложью.
      candidates: await Promise.all(
        alternatives.map(async (a) => {
          const facts = await compatFactsOf(a.route, a.model);
          return { adapter: compatAdapterOf(a.adapter), route: facts.route, model: facts.model };
        }),
      ),
    },
  };
}

/** Запасная тройка суда `tier`, найденная в реестрах дороги. */
export interface CompatCandidateRef {
  adapter: CliAdapter;
  route: Route;
  model: string | null;
}

/** Запись решения `compat` в журнал задачи классом `compat`: факты, размер набора, причина. */
export function compatRecord(decision: CompatDecision, inputs: CompatInputs): RouteDecisionRecord {
  return {
    class: 'compat',
    facts: inputs.facts.facts,
    numbers: { allowed: inputs.policy.allowed.length },
    reasons: [
      decision.kind === 'refused'
        ? `refused: ${decision.code}${decision.setting ? ` (${decision.setting})` : ''}`
        : decision.kind,
    ],
    output: decision,
  };
}
