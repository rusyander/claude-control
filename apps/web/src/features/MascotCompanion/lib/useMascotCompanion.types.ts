import type { MascotMood } from '@shared/ui/mascot';
import type { ChatTarget } from '../model/chatTargets.types';
import type { ReactionKind } from '../model/reactions.types';

/**
 * Фраза реплики ключом словаря, а не готовой строкой: реплика живёт секунды, и
 * за это время панель может сменить язык (первый запуск читает его из настроек
 * сервера уже после того, как Дека заговорил). Текст собирается заново на
 * каждом показе — фраза не остаётся на прежнем языке.
 */
export interface SpeechLine {
  key: string;
  /** Имя разговора или группы; пустое — «без названия» на текущем языке. */
  name?: string;
}

/** Реплика Деки: облачко у боковой панели или строка над полем ввода чата. */
export interface Speech {
  id: number;
  kind: 'ask' | 'error' | 'done' | 'greet' | 'tip' | 'wake' | 'dizzy' | 'react';
  /** Текст на текущем языке; хук пересобирает его из `line` при смене языка. */
  text: string;
  line?: SpeechLine;
  /** Когда облачко уходит само, мс эпохи. */
  until: number;
  /** Мимика на время реплики. */
  mood?: MascotMood;
  /** Разговор, куда ведёт кнопка в облачке. */
  target?: ChatTarget;
  /** Род реакции на событие (`kind: 'react'`). */
  reaction?: ReactionKind;
}
