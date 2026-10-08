export interface OpenedItem {
  kind: 'group' | 'found';
  id: string;
  /** Только что созданный сценарий: окно сразу зовёт составителя первого шага. */
  isFresh?: boolean;
}
