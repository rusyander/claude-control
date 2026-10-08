import type {
  Platform,
  PlatformRunLayers,
  PlatformDataMask,
  PlatformRuleRow,
  PlatformRuleConflict,
  PlatformRulesApplies,
} from '@agentdeck/contracts';

export interface OursRulesColumnProps {
  platform: Platform;
  /** Что из нашего унесёт прогон (Т8) — считает сервер, см. `RulesCard`. */
  layers?: PlatformRunLayers;
  dataMask?: PlatformDataMask;
  /** Прослойку не включить, пока у контура записан свой набор инструментов. */
  shimLocked: boolean;
  update: (next: Platform) => void;
  /** Правила контура — чтобы назвать другую сторону пересечения её именем. */
  rules: readonly PlatformRuleRow[];
  /** Пересечения с правилами контура — отметка под строкой, которой касаются. */
  conflicts: readonly PlatformRuleConflict[];
  /** Колонка снята выбором «чьи правила действуют» — каким именно. */
  offBy: PlatformRulesApplies | undefined;
}
