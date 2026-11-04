import { CORE_ECONOMY_DEFAULTS } from '@agentdeck/contracts/core/config';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { SessionEconomy } from '../../adapters/adapter.types.ts';
import { WORK_HABITS_LINE } from '../../adapters/economy-carry.ts';
import { readCoreConfig, sectionProblem } from '../../platform/core-config/read.ts';
import { CHAT_KIND } from './mcp-list.ts';

/**
 * Рычаги экономии шага на дороге (s10 p8, порт рычагов групп панели): раздел `economy` конфига
 * ядра читается на каждом старте сессии (правка — со следующего сеанса, без перезапуска) поверх
 * умолчаний панели (`CORE_ECONOMY_DEFAULTS`, s10 p9: нет раздела — рычаги групп панели включены) и
 * кладётся в `SessionSpec.economy` шагам задачи. Чат панели (chat@1) рычагов не получает — как
 * обычный разговор панели прежде; вид без сессии модели — тоже. Окно модели шага — факт маршрута
 * (`route-windows`), нужен CLI, чей порог сжатия — доля окна (Goose, Qwen, Kimi).
 */

export interface StepEconomy {
  economy?: SessionEconomy;
  /** Раздел не прошёл схему — причина (рычаги не трогаются). */
  problem?: string;
}

export function stepEconomy(
  configPath: string,
  stepKind: string,
  modelWindow: number | null,
): StepEconomy {
  if (stepKind === CHAT_KIND || !toolPlanFor(stepKind)) return {};
  const read = readCoreConfig({ config: configPath });
  if ('unknown' in read) return { problem: `core config unreadable: ${read.unknown}` };
  if (!('absent' in read)) {
    const problem = sectionProblem(read.value, 'economy');
    if (problem) return { problem };
  }
  const section = 'absent' in read ? undefined : read.value.doc.economy;
  // Поле раздела перекрывает умолчание панели; 0 / false — выключен явно и в спеку не идёт.
  const merged: Record<string, unknown> = { ...CORE_ECONOMY_DEFAULTS, ...section };
  const on = Object.fromEntries(
    Object.entries(merged).filter(([, value]) => value !== 0 && value !== false),
  ) as SessionEconomy;
  return { economy: { ...on, ...(modelWindow && modelWindow > 0 ? { modelWindow } : {}) } };
}

/** Бриф шага со строкой привычек (рычаг `workHabits`): в системной части, на всю сессию. */
export function briefWithHabits(brief: string, economy: SessionEconomy | undefined): string {
  return economy?.workHabits ? `${brief}\n\n${WORK_HABITS_LINE}` : brief;
}
