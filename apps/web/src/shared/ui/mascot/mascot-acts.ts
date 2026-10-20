import type { MascotMood } from './mascot.types';

/**
 * Разовое действие Деки поверх настроения. Покой — это не бесконечная петля, а
 * неподвижность, которую время от времени прерывает действие: моргнул,
 * огляделся, подпрыгнул. Между действиями браузер не рисует ни кадра.
 *
 *   switch — сжался и выпрямился: настроение сменилось;
 *   blink / blink2 — моргнул один или два раза;
 *   glance — посмотрел влево-вправо;
 *   stretch, hop — потянулся, подпрыгнул;
 *   wave — помахал;
 *   read — пробежал глазом строку (работает);
 *   look — оглянулся по сторонам (потерялся);
 *   snore — вздох во сне и «z-z-z»;
 *   call — подпрыгнул с «!» (ждёт ответа);
 *   flinch — вздрогнул (ошибка);
 *   ponder — «?» качнулся, шкала щёлкнула (думает).
 */
export type MascotAct =
  | 'switch'
  | 'blink'
  | 'blink2'
  | 'glance'
  | 'stretch'
  | 'hop'
  | 'wave'
  | 'read'
  | 'look'
  | 'snore'
  | 'call'
  | 'flinch'
  | 'ponder';

/** Длительность действия, мс: столько держится `data-act`, кадры в CSS — под неё. */
export const ACT_MS: Record<MascotAct, number> = {
  switch: 380,
  blink: 200,
  blink2: 520,
  glance: 1_600,
  stretch: 900,
  hop: 650,
  wave: 1_300,
  read: 2_400,
  look: 2_800,
  snore: 3_000,
  call: 1_800,
  flinch: 800,
  ponder: 1_600,
};

interface Repertoire {
  /** Действия и их веса: чем больше вес, тем чаще. */
  acts: readonly (readonly [MascotAct, number])[];
  /** Пауза между действиями, мс: случайная в этих пределах — ритм не угадывается. */
  gap: readonly [number, number];
  /** Пауза до первого действия, мс; без неё — как обычная. */
  first?: number;
}

/**
 * Что Дека делает в каждом настроении. `happy` и `dizzy` здесь нет: это вспышки
 * на три секунды, их движение — само настроение. `working` крутит шкалу
 * постоянно — это индикатор хода, — а глазом «читает» действиями.
 */
const REPERTOIRE: Partial<Record<MascotMood, Repertoire>> = {
  idle: {
    acts: [
      ['blink', 5],
      ['blink2', 2],
      ['glance', 2],
      ['stretch', 1],
      ['hop', 1],
      ['wave', 0.5],
    ],
    gap: [2_200, 5_500],
  },
  working: {
    acts: [
      ['read', 4],
      ['blink', 2],
    ],
    gap: [600, 2_200],
  },
  waiting: {
    acts: [
      ['call', 4],
      ['blink', 1],
    ],
    gap: [900, 2_400],
    first: 0,
  },
  error: {
    acts: [
      ['flinch', 3],
      ['blink', 1],
    ],
    gap: [1_500, 3_500],
    first: 200,
  },
  thinking: {
    acts: [
      ['ponder', 2],
      ['blink', 1],
    ],
    gap: [900, 2_400],
    first: 200,
  },
  sleeping: { acts: [['snore', 1]], gap: [1_200, 2_600], first: 400 },
  waving: { acts: [['wave', 1]], gap: [900, 2_600], first: 0 },
  lost: {
    acts: [
      ['look', 3],
      ['blink', 1],
    ],
    gap: [900, 2_400],
    first: 300,
  },
};

/** Случайное число в [0, 1) — подменяется в тестах. */
type Random = () => number;

function between([min, max]: readonly [number, number], random: Random): number {
  return Math.round(min + (max - min) * random());
}

/** Есть ли у настроения свои действия. */
export function hasActs(mood: MascotMood): boolean {
  return REPERTOIRE[mood] !== undefined;
}

/** Сколько ждать до первого действия в этом настроении, мс. */
export function firstDelay(mood: MascotMood, random: Random = Math.random): number {
  const repertoire = REPERTOIRE[mood];
  if (!repertoire) return 0;
  return repertoire.first ?? between(repertoire.gap, random);
}

/** Следующее действие по весам и пауза после него, мс. */
export function pickAct(
  mood: MascotMood,
  random: Random = Math.random,
): { act: MascotAct; gap: number } | null {
  const repertoire = REPERTOIRE[mood];
  if (!repertoire) return null;
  const total = repertoire.acts.reduce((sum, [, weight]) => sum + weight, 0);
  let roll = random() * total;
  // Последнее — на случай, если бросок упёрся ровно в сумму весов.
  let act = repertoire.acts.at(-1)?.[0];
  for (const [candidate, weight] of repertoire.acts) {
    if (roll < weight) {
      act = candidate;
      break;
    }
    roll -= weight;
  }
  return act ? { act, gap: between(repertoire.gap, random) } : null;
}
