/**
 * Модель составного правила: набор смысловых блоков, из которых собирается
 * текст правила. Блоки и их сборка в markdown вынесены сюда, чтобы конструктор
 * занимался только интерфейсом.
 */

export type SectionKind = 'allow' | 'deny' | 'caution' | 'custom';

export interface RuleSection {
  kind: SectionKind;
  /** Заголовок — только у произвольной секции; у остальных он предопределён. */
  title?: string;
  items: string[];
}
