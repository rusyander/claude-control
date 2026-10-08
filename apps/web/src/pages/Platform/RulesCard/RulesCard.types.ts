import type {
  Platform,
  PlatformRuleRow,
  PlatformRuleConflict,
  PlatformRunLayers,
  PlatformDataMask,
} from '@agentdeck/contracts';

export interface RulesCardProps {
  platform: Platform;
  /**
   * Правила из манифеста драйвера: чем распоряжаемся и что только видно.
   * Необязательны намеренно — ответ без них приносит рассинхрон версий, и
   * падение здесь унесло бы с экрана весь раздел, а не одну карточку.
   */
  rules?: PlatformRuleRow[];
  /** Ячейки матрицы: где правило контура спорит с нашим. */
  conflicts?: PlatformRuleConflict[];
  /**
   * Что из нашего унесёт прогон через этот контур (Т8) — СЧИТАЕТ СЕРВЕР. Экран
   * показывает готовые флаги, а не собирает их заново: разошедшись, вторая
   * сборка обещала бы снятый слой при полном запуске. Необязательны по той же
   * причине, что и правила выше: ответ старого сервера их не приносит.
   */
  layers?: PlatformRunLayers;
  /** Маска данных на этом контуре (Р11) — решение сервера, как и слои. */
  dataMask?: PlatformDataMask;
}
