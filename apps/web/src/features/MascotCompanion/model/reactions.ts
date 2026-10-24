import type { ReactionKind, ReactionMemory, ReactionPick } from './reactions.types';

/**
 * Сколько формулировок у каждой реакции: ключи `mascot.react.<род>.<0..n-1>`.
 * Тест сверяет число с ru и en, чтобы новая фраза не потерялась в одном языке.
 */
export const REACTION_VARIANTS: Record<ReactionKind, number> = {
  linkLost: 3,
  linkBack: 3,
  runFailed: 3,
  groupFailed: 3,
  groupStopped: 3,
  limitHit: 3,
  longDone: 3,
  groupDelivered: 3,
};

/**
 * Что важнее, когда события пришли пачкой: Дека говорит одну строку за раз, и
 * это должна быть строка о том, что требует человека. Связь пропала — первой:
 * пока её нет, остальное на экране может быть неправдой.
 */
const ORDER: ReactionKind[] = [
  'linkLost',
  'limitHit',
  'groupFailed',
  'runFailed',
  'groupStopped',
  'linkBack',
  'groupDelivered',
  'longDone',
];

/** Тот же род реакции — не чаще раза в столько, мс: пять упавших ходов подряд — одна фраза. */
export const REACTION_COOLDOWN_MS = 60_000;

/** Между любыми двумя реакциями — не меньше, мс: пачка событий даёт одну строку. */
export const REACTION_GAP_MS = 6_000;

/**
 * «Связь вернулась» — ответ на «связь пропала», а не новая новость: общий
 * промежуток её не держит, иначе быстрое возвращение осталось бы несказанным и
 * на экране висело бы устаревшее «пропала».
 */
const GAP_EXEMPT = new Set<ReactionKind>(['linkBack']);

export const EMPTY_MEMORY: ReactionMemory = { lastAt: undefined, byKind: {}, variant: {} };

/**
 * Какую реакцию сказать на пачку событий, и с какой формулировкой. Чистая
 * функция: часы и случайность приходят снаружи, память — прошлым результатом.
 *
 * - пачка → одна строка, самого важного рода по `ORDER`;
 * - род, сказанный меньше `REACTION_COOLDOWN_MS` назад, пропускается — берётся
 *   следующий по важности;
 * - меньше `REACTION_GAP_MS` с прошлой реакции — молчим (кроме `linkBack`);
 * - формулировка не повторяет прошлую этого рода.
 */
export function pickReaction(
  kinds: readonly ReactionKind[],
  memory: ReactionMemory,
  now: number,
  random: () => number = Math.random,
): ReactionPick | null {
  const present = ORDER.filter((kind) => kinds.includes(kind));
  const gapOpen = memory.lastAt === undefined || now - memory.lastAt >= REACTION_GAP_MS;
  const kind = present.find((candidate) => {
    const last = memory.byKind[candidate];
    if (last !== undefined && now - last < REACTION_COOLDOWN_MS) return false;
    return gapOpen || GAP_EXEMPT.has(candidate);
  });
  if (!kind) return null;

  const count = REACTION_VARIANTS[kind];
  const previous = memory.variant[kind];
  // Без прошлой — любая из всех; с прошлой — любая из остальных, сдвигом мимо неё.
  const span = previous === undefined || count < 2 ? count : count - 1;
  let variant = Math.min(span - 1, Math.floor(random() * span));
  if (previous !== undefined && count >= 2 && variant >= previous) variant += 1;

  return {
    kind,
    variant,
    memory: {
      lastAt: now,
      byKind: { ...memory.byKind, [kind]: now },
      variant: { ...memory.variant, [kind]: variant },
    },
  };
}
