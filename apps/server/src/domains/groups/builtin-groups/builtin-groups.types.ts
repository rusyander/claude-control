import type { LocalizedText } from '@agentdeck/contracts/group-path';

/** Одна встроенная группа каталога: тексты на двух языках и шаг профиля. */
export interface BuiltinGroupEntry {
  /** Стабильный id с префиксом `builtin-`. */
  id: string;
  name: LocalizedText;
  description: LocalizedText;
  /** Когда «Авто» выбирает группу — английским, читает модель. */
  when: string;
  /** Скилл, внутри порядка которого встаёт шаг профиля. */
  skill: string;
  step: { title: LocalizedText; prompt: LocalizedText; gate: LocalizedText };
}

/** Что сделал проход засева: для журнала сервера и ответа «Вернуть встроенные». */
export interface BuiltinSeedReport {
  added: string[];
  updated: string[];
}
