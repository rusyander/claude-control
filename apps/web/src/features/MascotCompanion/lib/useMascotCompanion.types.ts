import type { MascotMood } from '@shared/ui/mascot';
import type { ChatTarget } from '../model/chatTargets.types';

/** Реплика Деки в облачке у боковой панели. */
export interface Speech {
  id: number;
  kind: 'ask' | 'error' | 'done' | 'greet' | 'tip' | 'wake' | 'dizzy';
  text: string;
  /** Когда облачко уходит само, мс эпохи. */
  until: number;
  /** Мимика на время реплики. */
  mood?: MascotMood;
  /** Разговор, куда ведёт кнопка в облачке. */
  target?: ChatTarget;
}
