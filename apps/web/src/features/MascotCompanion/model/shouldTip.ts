import type { TipGate } from './shouldTip.types';

/** Первый совет — не раньше, чем через столько после открытия панели. */
export const FIRST_TIP_AFTER_MS = 3 * 60_000;

/** Между двумя репликами по своей инициативе — не меньше. */
export const TIP_GAP_MS = 9 * 60_000;

/** Человек печатал или кликал недавно — не перебиваем. */
export const QUIET_INPUT_MS = 5_000;

/**
 * Пора ли Деке дать совет самому. Маскот, который болтает под руку, выключают
 * в первый же день, поэтому условий много и все — «не мешать»: реплики включены,
 * вкладка видна, никто не ждёт ответа и ничего не упало, сводка закрыта, ничего
 * не сказано только что, человек не печатает и не спит.
 */
export function shouldTip(gate: TipGate): boolean {
  if (!gate.chatty || gate.hidden || gate.asleep || gate.panelOpen || gate.speaking) return false;
  if (gate.attention > 0) return false;
  if (gate.now - gate.mountedAt < FIRST_TIP_AFTER_MS) return false;
  if (gate.lastSpokeAt !== undefined && gate.now - gate.lastSpokeAt < TIP_GAP_MS) return false;
  return gate.now - gate.lastInputAt >= QUIET_INPUT_MS;
}
