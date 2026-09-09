export interface WorktreeMirrorSettingsProps {
  /** Основная копия проекта — по ней шаблоны и хранятся. */
  path: string;
  /** Идёт другая операция раздела — сохранение тоже ждёт. */
  disabled: boolean;
}
