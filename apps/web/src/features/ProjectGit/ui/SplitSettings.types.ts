export interface SplitSettingsProps {
  /** Основная копия проекта — по ней настройка и хранится. */
  path: string;
  /** Идёт другая операция раздела — сохранение тоже ждёт. */
  disabled: boolean;
}
