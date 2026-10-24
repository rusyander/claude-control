import type { ModelInfo } from '@agentdeck/contracts';
import {
  ASSIGNABLE_EFFORTS,
  EFFORT_RANK,
  type AssignableEffort,
} from '@agentdeck/contracts/model-cascade';
import {
  planForeignAssignment,
  type CascadeProvider,
} from '../../provider-cascade/provider-cascade.ts';

/** План звена глазами подмены (`ForeignStagePlan`): без обратного импорта из `cascade.ts`. */
interface DeliverPlanShape {
  stage: string;
  model?: string;
  effort?: string;
}

/**
 * Маршрут контура, которым пойдёт СЛЕДУЮЩИЙ прогон этого CLI (`resolveRunRoute`
 * для `foreign:<cli>`). `modelMapKeys` — имена, которые переводит карта
 * соответствия контура (в нижнем регистре, `PlatformRunRoute.modelMapKeys`).
 */
export interface DeliverContourRoute {
  routed: boolean;
  modelMapKeys?: readonly string[];
}

/**
 * Доставка группы чужого CLI на младшей ступени его лестницы (C2) — аналог
 * «Доставки на Sonnet» у Claude (`withCheapDeliver` в `ChatCascadeStages.ts`).
 * Коммит, пуш, MR и сита — механика, и платить за неё ступенью работы незачем.
 *
 * Младшая ступень — та же, что подбор отдаёт механике (`planForeignAssignment`,
 * класс `mechanical` = ступень 0): правило «своя лестница, свежайшая в семействе,
 * fail-closed» не дублируется. Лестницы нет (Goose, Kimi, OpenCode, Continue),
 * модель не передать или семейства нет в каталоге — план как есть, доставка на
 * модели работы, ровно как до рычага.
 *
 * Через контур модель решает его карта соответствия — то же правило, что у
 * Claude (`routedMap?.includes(CHEAP_DELIVER_MODEL)` в `handoff-routes.ts`):
 * строки для младшей ступени нет — просьба ушла бы в модель контура по
 * умолчанию, ни экономии, ни смысла, и доставка остаётся на модели работы.
 *
 * Глубина — см. `cheapDeliverEffort`. Шапка звена по-прежнему помнит модель
 * РАБОТЫ (`workModel`): доставка — конец цепочки, и выдавать себя за работу ей
 * незачем; по ней же доставка и откатывается, если младшую ступень отвергли
 * (`workDeliverAfterRefusal`).
 */
export function withForeignCheapDeliver<P extends DeliverPlanShape>(
  plan: P,
  provider: CascadeProvider,
  models: ModelInfo[],
  route: DeliverContourRoute,
): P {
  if (plan.stage !== 'deliver') return plan;
  const tier0 = planForeignAssignment(provider, models, { kind: 'mechanical' });
  if (!tier0) return plan;
  if (route.routed && !route.modelMapKeys?.includes(tier0.model.toLowerCase())) return plan;
  const effort = cheapDeliverEffort(plan.effort, tier0.effort);
  const { effort: _work, ...rest } = plan;
  return { ...rest, model: tier0.model, ...(effort ? { effort } : {}) } as P;
}

/**
 * Глубина дешёвой доставки: дешёвая модель не повод ДУМАТЬ глубже, чем думала бы
 * доставка без рычага. Потолок — глубина самой младшей ступени по правилу панели
 * (`FOREIGN_TIER.mechanical` в `provider-cascade.ts`, сейчас `medium`):
 *
 * - глубина работы известна и не выше потолка — остаётся своей;
 * - ниже лестницы панели (`minimal`, `none` у Codex) — тоже своя;
 * - выше потолка (`high`, `xhigh`) или незнакомое слово — потолок;
 * - глубины у работы не было (класс-потолок шёл настройкой CLI) — флага нет:
 *   доставка думает так, как задано в настройках самого CLI, ровно как без
 *   рычага. Потолок здесь перебил бы `model_reasoning_effort = "low"` человека
 *   в `config.toml` и поднял бы глубину;
 * - у потолка глубины нет — флага нет вовсе, решает CLI.
 *
 * Прежде здесь стоял `high` по образцу Sonnet у Claude, и доставка без глубины
 * работы (ревью, разбор) или с `xhigh` уезжала с `high` — ВЫШЕ, чем шла бы без
 * рычага.
 */
export function cheapDeliverEffort(
  work: string | undefined,
  tierCap: string | undefined,
): string | undefined {
  const cap = knownEffort(tierCap);
  if (!cap) return undefined;
  const name = normalEffort(work);
  if (!name) return undefined;
  if (BELOW_LADDER.has(name)) return name;
  const own = knownEffort(name);
  return own && EFFORT_RANK[own] <= EFFORT_RANK[cap] ? own : cap;
}

/** Глубины ниже `low`: их знает CLI (Codex), лестница панели — нет. */
const BELOW_LADDER = new Set(['minimal', 'none']);

function normalEffort(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function knownEffort(value: string | undefined): AssignableEffort | undefined {
  const name = normalEffort(value);
  return ASSIGNABLE_EFFORTS.find((effort) => effort === name);
}

/**
 * Отказ ИМЕННО в модели: аккаунт или маршрут её не знает или не пускает. Тексты
 * — настоящие ответы codex-cli 0.155.1 (заглушка модели, `ProviderChatRun`):
 * «unexpected status 404 Not Found: The model `gpt-5.3-codex-spark` does not
 * exist or you do not have access to it.» и «{"detail":"The
 * 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT
 * account."}»; плюс коды OpenAI (`model_not_found`) и форма Gemini («models/… is
 * not found»).
 *
 * Лимиты и квоты — НЕ отказ в модели: на модели работы они упадут точно так же,
 * а повтор уже ведёт надзор (`run-retry`). Каталог панели доступа не знает вовсе
 * (models.dev — что выпущено, а не что пускает подписка), поэтому узнать отказ
 * можно только по ответу.
 */
export function isModelRefusal(error: string | undefined, model: string): boolean {
  const text = (error ?? '').toLowerCase();
  if (!text) return false;
  if (/rate.?limit|quota|usage limit|too many requests|\b429\b/.test(text)) return false;
  if (
    /\bmodel_(?:not_found|not_supported|not_available)\b|\b(?:unsupported|unknown|invalid)[ _]model\b/.test(
      text,
    )
  ) {
    return true;
  }
  // Модель и отказ — в одной строке: «access denied» от `git push` рядом с именем
  // модели в другой строке вывода — не отказ в модели.
  const name = model.toLowerCase();
  return text.split(/\r?\n/).some((line) => {
    const aboutModel = (Boolean(name) && line.includes(name)) || /\bmodels?\b/.test(line);
    return (
      aboutModel &&
      /does not exist|do(?:es)? not have access|no access|not (?:found|supported|available|allowed|enabled|permitted)|access denied/.test(
        line,
      )
    );
  });
}

/** Чем закончилась доставка, глазами отката. */
export interface FailedDeliverInput {
  /** Шапка разговора доставки: стадия и модель работы. */
  cascade: { stage?: string; workModel?: string; workEffort?: string } | undefined;
  /** Модель, на которой доставка шла. */
  chatModel: string | undefined;
  ok: boolean;
  stopped?: boolean;
  error?: string;
  /** Надзор назначил повтор того же хода — откат подождёт его итога. */
  retry?: { attempt: number } | { exhausted: number };
}

/**
 * Младшую ступень отвергли — доставка уходит на модели РАБОТЫ (C2, безопасность
 * доступа). Рычаг включён по умолчанию у каждой группы, а подписка может не
 * пускать в младшую модель (у Codex `-spark` есть не у всех аккаунтов): без
 * отката каждая доставка такой группы падала бы, а MR не появлялся.
 *
 * Откат — только для подмены, сделанной рычагом: доставка шла на младшей ступени
 * этого провайдера, и она не совпадает с моделью работы. Поэтому он случается
 * не больше одного раза: новый разговор идёт на модели работы, и второй отказ
 * сюда уже не подходит. Назначенный надзором повтор (`attempt`) — не повод:
 * пусть сначала отработает он.
 *
 * `undefined` — откатывать нечего; иначе модель и глубина доставки без рычага
 * (пустая модель = настройка CLI, как у работы на потолке).
 */
export function workDeliverAfterRefusal(
  input: FailedDeliverInput,
  provider: CascadeProvider,
  models: ModelInfo[],
): { model?: string; effort?: string } | undefined {
  const { cascade, chatModel } = input;
  if (input.ok || input.stopped || cascade?.stage !== 'deliver' || !chatModel) return undefined;
  if (input.retry && 'attempt' in input.retry) return undefined;
  if (chatModel === cascade.workModel) return undefined;
  const tier0 = planForeignAssignment(provider, models, { kind: 'mechanical' });
  if (tier0?.model !== chatModel) return undefined;
  if (!isModelRefusal(input.error, chatModel)) return undefined;
  return {
    ...(cascade.workModel ? { model: cascade.workModel } : {}),
    ...(cascade.workEffort ? { effort: cascade.workEffort } : {}),
  };
}
