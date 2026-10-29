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
import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { CliAdapter } from '../../adapters/index.ts';
import type { LiveTask } from '../../journal/resume.ts';
import { readJournalLines } from '../../journal/read-lines.ts';

/**
 * Совместимость до запуска (11 R:PR-05): дорога сессии собирает здесь факты переходника и
 * маршрута, сама зовёт единственного судью `compat` и пишет его решение в журнал записью отсюда —
 * до токена, каталога и процесса. Модуль не отдаёт решений: функция с результатом `CompatDecision`
 * вне `routes/compat` — второй судья (P01). Отказ — ничего не запускается. Разрешённый набор — из
 * `task.created` этой задачи (06 §Precedence), а не из запроса.
 *
 * Обход канала переходник пока не читает — `bypassActive` пуст, и канал с обходом не открыт
 * (fail-closed, P46). Звена шлюза ещё нет (стадия 5): решение `via-gateway` — отказ запуска.
 */

const stateOf = <T>(fact: Fact<T>): FactState =>
  'value' in fact ? 'value' : 'absent' in fact ? 'absent' : 'unknown';

export function allowedOf(task: LiveTask): AllowedTriple[] {
  const created = readJournalLines(task.dir, task.taskId).lines.find(
    (line): line is JournalLine<'task.created'> => line.kind === 'task.created',
  );
  return (created?.data.allowedRoutes ?? []).map((t) => ({
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

export async function compatFactsOf(route: Route, model: string): Promise<CompatFacts> {
  const decl = (fact: string) => route.facts.find((f) => f.fact === fact);
  const [availability, credential, models] = await Promise.all([
    route.read.availability(),
    route.read.credential(),
    route.read.models(),
  ]);
  const credentialState: CompatRoute['credential'] =
    'value' in credential
      ? credential.value.kind === 'none'
        ? 'none'
        : credential.value.present
          ? 'value'
          : 'absent'
      : stateOf(credential);
  const served = 'value' in models ? models.value.find((m) => m.id === model) : undefined;
  const modelFacts: ModelFacts = {
    id: model,
    served: 'value' in models ? (served ? 'value' : 'absent') : stateOf(models),
    ...(served?.contextTokens !== undefined ? { contextTokens: served.contextTokens } : {}),
    ...(served?.tools !== undefined ? { tools: served.tools } : {}),
  };
  return {
    route: {
      id: route.id,
      caps: route.caps,
      availability: {
        state: stateOf(availability),
        onUnknown: decl('availability')?.onUnknown ?? 'refuse',
      },
      credential: credentialState,
    },
    model: modelFacts,
    facts: [
      {
        readClass: decl('availability')?.readClass ?? 'route.availability',
        kind: stateOf(availability),
      },
      { readClass: decl('credential')?.readClass ?? 'route.credential', kind: stateOf(credential) },
      { readClass: decl('models')?.readClass ?? 'route.models', kind: stateOf(models) },
    ],
  };
}

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
  model: string,
): Promise<CompatInputs> {
  return {
    adapter: compatAdapterOf(adapter),
    facts: await compatFactsOf(route, model),
    policy: {
      allowed: allowedOf(task),
      dlp: { required: false, parses: [] },
      translations: [],
      needsTools: true,
      // Кандидатов дорога не собирает: факты чужих троек (модели, доступ) она не читала, а
      // замену с непрочитанными фактами назвать было бы ложью (P110). Их называет выбор маршрута.
      candidates: [],
    },
  };
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
