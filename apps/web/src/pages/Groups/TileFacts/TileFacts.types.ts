export interface TileFactsProps {
  /** Первые шаги на языке интерфейса — из записи группы, читать нечего. */
  steps: string[];
  /** Сколько шагов не поместилось в превью. */
  moreSteps?: number;
  /** Текст, когда шагов нет: у конвейера и у сценария он разный. */
  noStepsText: string;
  /** Участники любого вида: у находки их виды шире, чем у группы. */
  members: readonly { kind: string }[];
  /** Сколько чисел скиллов закреплено группой. */
  pinned?: number;
  /** Проекты, где группа включается сама (полные пути). */
  projects?: readonly string[];
}

export interface StepsPreviewProps {
  steps: string[];
  more: number;
  emptyText: string;
}
