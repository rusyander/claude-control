import type { IconName } from '@shared/ui/icon';

export interface CommandPaletteProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
}

/** Одна строка выдачи палитры: раздел для перехода или результат поиска. */
export interface PaletteOption {
  /** Стабильный идентификатор для aria-activedescendant и ключа списка. */
  id: string;
  icon: IconName;
  title: string;
  /** Пояснение под заголовком: путь раздела или фрагмент совпадения. */
  subtitle?: string;
  /** Куда перейти при выборе. */
  run: () => void;
}
