import type { PlatformViolationReport } from '@agentdeck/contracts';

export interface ViolationsCardProps {
  /**
   * Сводки может не быть, и она может прийти неполной: сервер старее фронта,
   * ответ из кэша, заглушка прогона. Ни одно поле не читается напрямую —
   * упавшая карточка утащила бы за собой всю страницу «Контур», а не себя одну.
   */
  report: PlatformViolationReport | undefined;
  /**
   * Включённые контуры, `id → название`. Панель обслуживает их несколько, и
   * строка без принадлежности читается как принадлежащая тому, на который
   * человек сейчас смотрит.
   */
  platformTitles: Record<string, string>;
}
