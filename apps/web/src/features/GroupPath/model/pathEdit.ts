import {
  PATH_ANCHORS,
  type PathAnchor,
  type PathEntry,
  type PathStep,
  type PathWithin,
} from '@agentdeck/contracts';

/**
 * Правка своих шагов пути на клиенте. Сервер хранит только свои шаги — у каждого
 * стадия, ПОСЛЕ которой он идёт (`anchor`), и место внутри неё (`order`); общий
 * порядок строк собирает он же. Здесь — только перевод жестов человека («+»
 * между двумя строками, «выше», «ниже», «убрать») в новый список своих шагов,
 * который уходит одним PUT.
 */

/** Свои шаги в том порядке, в каком их показывает путь. */
export function customSteps(entries: PathEntry[]): PathStep[] {
  return entries.flatMap((entry) => (entry.kind === 'custom' ? [entry.step] : []));
}

/**
 * Единственный ряд сценария. Стадий у сценария нет, и все его шаги стоят под
 * одной — той же, под которую их пишет агент панели (`actions-groups`). Место
 * шага — только номер в этом ряду.
 */
export const SCENARIO_ANCHOR: PathAnchor = 'work';

/**
 * Путь сценария: сервер собирает его без строк стадий (`buildPath`), у
 * конвейера они есть всегда — даже без единого своего шага.
 */
export function isScenarioPath(entries: PathEntry[]): boolean {
  return !entries.some((entry) => entry.kind === 'builtin');
}

/**
 * К какой стадии относится вставка после строки `index`: ближайшая стадия
 * выше по списку (или стадия ближайшего своего шага). Шаги скилла стадии не
 * задают — это показ, их пропускаем. Выше ничего нет — первая стадия.
 *
 * У сценария ряд один (F-126): вставка наверх под первую стадию давала ему
 * вторую, и позиция «встать N-м», посчитанная по ряду `work`, промахивалась.
 */
export function anchorAfter(entries: PathEntry[], index: number): PathAnchor {
  if (isScenarioPath(entries)) return SCENARIO_ANCHOR;
  for (let position = Math.min(index, entries.length - 1); position >= 0; position -= 1) {
    const entry = entries[position];
    if (entry?.kind === 'builtin') return entry.stage;
    if (entry?.kind === 'custom') return entry.step.anchor;
  }
  return PATH_ANCHORS[0] ?? 'triage';
}

/**
 * Номера внутри стадии по порядку списка: 0, 1, 2… Сервер сортирует по
 * `order`, поэтому дыры и повторы после вставки или удаления надо закрыть здесь.
 */
export function renumber(steps: PathStep[]): PathStep[] {
  const next = new Map<PathAnchor, number>();
  return steps.map((step) => {
    const order = next.get(step.anchor) ?? 0;
    next.set(step.anchor, order + 1);
    return step.order === order ? step : { ...step, order };
  });
}

/** Место своего шага: стадия, после которой он идёт, и — внутри порядка скилла — где именно. */
export interface PathSlot {
  anchor: PathAnchor;
  within?: PathWithin;
}

function isInSkillBlock(entry: PathEntry | undefined): boolean {
  return entry?.kind === 'skill-step' || (entry?.kind === 'custom' && Boolean(entry.step.within));
}

/**
 * Место шага, вставленного между строкой `index` и следующей. Рядом с шагами
 * скилла шаг встаёт ВНУТРЬ его порядка (`within`): иначе сервер унёс бы его
 * ниже всего блока скиллов, и «+» между шагами 4 и 5 соврал бы. После
 * последнего шага блока — обычный шаг стадии: он идёт отдельным ходом.
 */
export function slotAfter(entries: PathEntry[], index: number): PathSlot {
  const entry = entries[index];
  const next = entries[index + 1];
  if (entry?.kind === 'custom' && entry.step.within) {
    return { anchor: entry.step.anchor, within: entry.step.within };
  }
  if (entry?.kind === 'skill-step' && isInSkillBlock(next)) {
    return {
      anchor: 'work',
      within: { skillId: entry.skillId, index: entry.index, after: entry.title },
    };
  }
  if (entry?.kind === 'builtin' && isInSkillBlock(next)) {
    if (next?.kind === 'custom' && next.step.within) {
      return { anchor: next.step.anchor, within: next.step.within };
    }
    if (next?.kind === 'skill-step') {
      return { anchor: 'work', within: { skillId: next.skillId, index: -1, after: '' } };
    }
  }
  return { anchor: anchorAfter(entries, index) };
}

function placed(step: PathStep, slot: PathSlot): PathStep {
  const { within: _drop, ...rest } = step;
  return slot.within
    ? { ...rest, anchor: slot.anchor, within: slot.within }
    : { ...rest, anchor: slot.anchor };
}

/**
 * Вставить шаг после строки `index` пути. Шаг получает место этой вставки
 * (`slotAfter`) и встаёт за последним своим шагом, стоящим не ниже неё.
 */
export function insertAfter(entries: PathEntry[], index: number, step: PathStep): PathStep[] {
  const before = customSteps(entries.slice(0, index + 1));
  const after = customSteps(entries.slice(index + 1));
  const steps = [...before, placed(step, slotAfter(entries, index)), ...after];
  // Сценарий из прежних сохранений мог нести шаги под разными стадиями: они
  // сводятся в один ряд в том порядке, в каком их видит человек.
  return renumber(
    isScenarioPath(entries)
      ? steps.map((item) =>
          item.anchor === SCENARIO_ANCHOR ? item : { ...item, anchor: SCENARIO_ANCHOR },
        )
      : steps,
  );
}

/**
 * Перенести свой шаг так, чтобы он встал сразу после строки `afterIndex`
 * (индекс в `entries` ДО переноса) — то, что делает перетаскивание. Место
 * считается по списку без самого шага, поэтому перенос через стадию или внутрь
 * скилла меняет и стадию, и `within`. Ничего не меняется — тот же массив.
 */
export function moveToSlot(entries: PathEntry[], id: string, afterIndex: number): PathStep[] {
  const steps = customSteps(entries);
  const from = entries.findIndex((entry) => entry.kind === 'custom' && entry.step.id === id);
  const entry = entries[from];
  if (!entry || entry.kind !== 'custom') return steps;
  if (afterIndex === from || afterIndex === from - 1 || afterIndex < topSlot(entries)) return steps;
  const rest = entries.filter((_, index) => index !== from);
  const at = afterIndex > from ? afterIndex - 1 : afterIndex;
  return insertAfter(rest, at, entry.step);
}

/**
 * Самое верхнее место вставки. У конвейера первая строка — стадия, и встать
 * выше неё нельзя: сервер всё равно поставит шаг после стадии. У сценария
 * стадий нет — шаг можно положить в самое начало (`-1`).
 */
export function topSlot(entries: PathEntry[]): -1 | 0 {
  return entries[0]?.kind === 'builtin' ? 0 : -1;
}

/**
 * Сдвинуть свой шаг на одну строку пути вверх или вниз — через шаг скилла,
 * стадию или соседний свой шаг. У края пути — тот же массив.
 */
export function moveInPath(entries: PathEntry[], id: string, delta: -1 | 1): PathStep[] {
  const from = entries.findIndex((entry) => entry.kind === 'custom' && entry.step.id === id);
  if (from < 0) return customSteps(entries);
  return moveToSlot(entries, id, delta < 0 ? from - 2 : from + 1);
}

/** Можно ли сдвинуть: на краю пути стрелка гаснет, а не молча ничего не делает. */
export function canMoveInPath(entries: PathEntry[], id: string, delta: -1 | 1): boolean {
  const from = entries.findIndex((entry) => entry.kind === 'custom' && entry.step.id === id);
  if (from < 0) return false;
  return delta < 0 ? from - 2 >= topSlot(entries) : from + 1 < entries.length;
}

/** Заменить шаг с тем же id (правка текста) — место и стадия остаются. */
export function replaceStep(steps: PathStep[], step: PathStep): PathStep[] {
  return steps.map((item) =>
    item.id === step.id
      ? placed(step, { anchor: item.anchor, ...(item.within ? { within: item.within } : {}) })
      : item,
  );
}

export function removeStep(steps: PathStep[], id: string): PathStep[] {
  return renumber(steps.filter((step) => step.id !== id));
}
