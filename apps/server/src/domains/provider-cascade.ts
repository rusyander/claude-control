import type { ModelInfo } from '@agentdeck/contracts';
import {
  isBigGroup,
  TASK_KINDS,
  type CascadeGroup,
  type CascadePlan,
  type TaskKind,
} from '@agentdeck/contracts/model-cascade';
import { newestInFamily } from './models/model-defaults.ts';
import type { ConfigProvider } from '../providers/types.ts';

/**
 * Подбор модели под класс работы у ЧУЖОГО провайдера (этап 3 партии).
 *
 * Отдельный модуль от `model-cascade.ts`, и это не дробление ради красоты: у
 * Claude подбор устроен вокруг ПОТОЛКА — человек выбрал модель разговора, и всё
 * считается вниз от неё. У чужого CLI потолка нет и взяться ему неоткуда:
 * панель не знает ни его настроенной модели, ни подписки пользователя, ни того,
 * что ему вообще доступно. Знает она ровно одно — какие семейства есть в
 * каталоге models.dev у вендора этого CLI.
 *
 * Отсюда всё остальное:
 *
 * 1. ПОНИЖАЕМ, НО НЕ ПОВЫШАЕМ. Классу, которому положен потолок (`design`,
 *    `investigation`, `review`, а также неназванный и незнакомый), панель не
 *    передаёт модель ВООБЩЕ — прогон идёт настройкой пользователя. Это и есть
 *    его потолок, и трогать его нельзя: любая подставленная сверху модель была
 *    бы гаданием о чужом доступе.
 * 2. СТУПЕНИ — ТОЛЬКО СВОЕГО ВЕНДОРА И ТОЛЬКО ОДНОРОДНЫЕ. Лестница объявлена на
 *    провайдере (`modelLadder`, см. три условия в его типе); нет лестницы —
 *    подбора нет, молча и навсегда, а не «пока не дошли руки».
 * 3. ПОКОЛЕНИЕ ВСЕГДА ПОСЛЕДНЕЕ. Ступень — это СЕМЕЙСТВО, конкретное имя даёт
 *    `newestInFamily`. Тот же инвариант, ради которого у Claude появился
 *    `expandAssignedModel`: понижение ступени не должно превращаться в
 *    понижение поколения.
 *
 * Чего здесь НЕТ и почему: конвейера «работа → ревью → правки». Он живёт на
 * реестре прогонов Claude (`ChatRunRegistry` → планировщик в
 * `routes/chat/handoff-routes.ts`), а разговоры чужих CLI ведёт другой домен, и
 * событий завершения он наружу не отдаёт. Поэтому у чужого провайдера понижение
 * подкрепляется только планкой сдачи в задании (`loweredWorkPrompt`), а не
 * проверкой на потолке — так и написано в справке, обещать больше нечестно.
 */

/**
 * Ступень лестницы и глубина по классу работы. `undefined` — класс, который
 * панель не удешевляет; тогда прогон едет без флага модели.
 *
 * Таблица намеренно повторяет форму `KIND_PLAN` из контрактов, а не выводится из
 * неё: у Claude ступени называются алиасами (`sonnet`), здесь — номером в чужой
 * лестнице, и общего значения у них нет. Синхронность держит тест «класс с
 * потолком в `KIND_PLAN` обязан быть потолком и тут»: разойтись двум таблицам он
 * не даст, а новый класс в наборе не соберётся без записи в обеих.
 */
const FOREIGN_TIER: Readonly<Record<TaskKind, { tier: number; effort: string } | undefined>> = {
  // Механика: младшая ступень лестницы, быстрое продумывание.
  mechanical: { tier: 0, effort: 'medium' },
  // Понятная работа с готовыми критериями: старшая ступень, полное продумывание.
  implementation: { tier: 1, effort: 'high' },
  tests: { tier: 1, effort: 'high' },
  // Потолок — то есть собственная настройка CLI, флаг не передаётся.
  investigation: undefined,
  design: undefined,
  review: undefined,
};

/** Провайдер глазами подбора: только то, от чего он зависит. */
export type CascadeProvider = Pick<ConfigProvider, 'modelLadder' | 'assistant'>;

/**
 * Чем вести группу у чужого провайдера. `undefined` значит «ничего не передаём»
 * — и это правильный, а не аварийный ответ: так едут и класс-потолок, и любой
 * CLI без лестницы.
 */
export function planForeignAssignment(
  provider: CascadeProvider,
  models: ModelInfo[],
  group: CascadeGroup,
): CascadePlan | undefined {
  const ladder = provider.modelLadder;
  // Лестница без способа передать модель — недоразумение конфигурации: молча
  // подобранная модель никуда бы не уехала, а карточка показала бы её человеку.
  if (!ladder?.length || !provider.assistant?.oneShotArgs) return undefined;

  const kind = TASK_KINDS.find((known) => known === (group.kind ?? '').trim().toLowerCase());
  if (!kind) return undefined;

  const plan = FOREIGN_TIER[kind];
  if (!plan) return undefined;

  // Большая группа механикой не бывает — та же поправка, что и у Claude, и тот
  // же предикат: расходиться этим правилам нечем.
  const tier = isBigGroup(group) ? Math.max(plan.tier, 1) : plan.tier;
  const effort = isBigGroup(group) && plan.effort === 'medium' ? 'high' : plan.effort;

  // Лестница короче ступени — берём самую верхнюю из объявленных: провайдер с
  // одной ступенью это законная конфигурация, а не ошибка.
  const family = ladder[Math.min(tier, ladder.length - 1)];
  const model = family ? newestInFamily(models, family)?.id : undefined;
  // Семейства нет в каталоге (не скачался, вендор переименовал линейку) —
  // fail-closed: прогон идёт настройкой пользователя, как будто подбора нет.
  if (!model) return undefined;

  return { model, effort, kind, lowered: true };
}
