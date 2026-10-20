import type { MascotMood } from './mascot.types';

/** Все настроения по порядку — для витрины и проверок. */
export const MASCOT_MOODS: readonly MascotMood[] = [
  'idle',
  'working',
  'waiting',
  'error',
  'happy',
  'sleeping',
  'thinking',
  'waving',
  'lost',
  'dizzy',
];
