export interface BulkPresetItem {
  id: string;
  title: string;
  description?: string;
}

export interface BulkPresetsProps {
  items: BulkPresetItem[];
  /** Создать один элемент по id пресета. Возвращает промис — ждём завершения. */
  createOne: (id: string) => Promise<unknown>;
  /** Закрыть окно после создания набора. */
  onDone: () => void;
}
