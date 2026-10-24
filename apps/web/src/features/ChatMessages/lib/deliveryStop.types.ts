/** Пункт «чего не хватило до доставки» по частям. */
export interface DeliveryStopItem {
  /** Сито или блок — «сито «интеграция»», «блок «Тесты» копии». Нет — пункт без имени. */
  name?: string;
  /** Что не так. */
  what: string;
  /** Что сделать — часть после « — ». */
  todo?: string;
}

/**
 * Пункт, который агент закрыть не может и не вправе (владелец 23.10.2026):
 * мерж MR; удаление (git или вне своей копии), force-push сверх аренды доставки или
 * запись в БД (`destructive`); доступ, которого нет нигде в проекте; повреждённое
 * хранилище объектов git копии (`corrupt-store`, INST-D) — его агент не чинит.
 */
export type DeliveryHumanKind = 'merge' | 'destructive' | 'credentials' | 'corrupt-store';

export interface DeliveryHumanItem {
  kind: DeliveryHumanKind;
  item: DeliveryStopItem;
}

/**
 * Почему панель перестала напоминать группе (коды `split-delivery-*` сервера):
 * напоминание ничего не сдвинуло, потолок напоминаний, разбор на усиленной
 * модели тоже ничего не сдвинул, потолок повторов самой панели (`retry-cap`).
 */
export type DeliveryStall = 'stalled' | 'nudge-cap' | 'escalation-stalled' | 'retry-cap';

/**
 * Группа, остановленная на доставке: пункты, которые закроет агент, когда
 * группу продолжат, и пункты только для человека — каждый с точным действием.
 */
export interface DeliveryStop {
  auto: DeliveryStopItem[];
  human: DeliveryHumanItem[];
  /** Почему панель перестала напоминать; нет — причина не названа (запись постарше). */
  stall?: DeliveryStall;
}
