export interface SkillTextStep {
  title: string;
  /** Номер строки заголовка (с нуля). */
  line: number;
  /** Номер шага, как написан в заголовке. */
  number: number;
  /** Смещение строки заголовка в тексте. */
  start: number;
  /** Где кончается раздел шага: следующий шаг или заголовок не глубже. */
  end: number;
  /** Текст раздела без заголовка. */
  body: string;
}
