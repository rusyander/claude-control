import type { MascotMood } from '@shared/ui/mascot';

export interface MoodInput {
  /** Разговоров, ждущих ответа человека. */
  waiting: number;
  /** Прогонов с ошибкой. */
  errors: number;
  /** Прогонов, которые работают (и молчащих тоже). */
  running: number;
  /** Человек давно ничего не трогал. */
  asleep: boolean;
  /** Короткая вспышка поверх всего, кроме вопроса. */
  flash?: { mood: MascotMood; until: number };
  /** Мимика текущей реплики. */
  speechMood?: MascotMood;
  now: number;
}

export interface StatusLine {
  /** Ключ `mascot.status.<key>`. */
  key: 'idle' | 'sleeping' | 'working' | 'waiting' | 'error';
  count?: number;
}
