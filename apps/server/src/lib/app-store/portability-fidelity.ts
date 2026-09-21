import type { FidelityMark } from '@agentdeck/contracts/portable-fidelity';
import { sameFidelityPromise } from '@agentdeck/contracts/portable-fidelity';
import type { AppState } from './app-store.types.ts';

/**
 * Последний ОТТИСК отчёта верности по паре «источник → цель» (П1.2).
 *
 * Живёт в состоянии панели, а не в настройках, по той же причине, что и след
 * применения контура: отчёт описывает ЭТУ машину — её установленные CLI и их
 * файлы, — и на другой машине означал бы чужую среду под своим именем.
 *
 * Хранится ради сравнения, а не ради показа: отчёт на экране всегда считается
 * заново (это чистая функция над паспортом), а сохранённый отвечает на вопрос
 * «что панель обещала в прошлый раз» — версия канона и дата лежат внутри него,
 * поэтому прочитанный завтра он умеет сказать, что посчитан по другому словарю.
 *
 * ДВА ОГРАНИЧЕНИЯ, без которых хранение само себя обесценивало:
 *
 *  1. **Строк здесь нет.** Отчёт по реальному дому — 55 КБ; ключей до двухсот
 *     (десять CLI × десять × два уровня). Маршрут только читает файлы, и
 *     разрастание `state.json` до мегабайт на каждом открытии страницы — цена
 *     ни за что: строки считаются заново.
 *  2. **Запись ТОЛЬКО при изменении обещания.** Пока оттиск переписывался на
 *     каждом запросе, «прошлый раз» означал «секунду назад»: одно обновление
 *     страницы затирало базу сравнения, и строка «прошлый расчёт обещал другое»
 *     не могла появиться в принципе.
 */

/** Ключ записи: пара CLI плюс уровень. Уровень в ключе — у проекта своя среда. */
export function fidelityReportKey(
  source: string,
  target: string,
  scope: string,
  /** Идентификатор проекта на уровне проекта: обещания разным проектам разные. */
  project?: string,
): string {
  const base = `${source}->${target}:${scope}`;
  return project ? `${base}@${project}` : base;
}

export function getPortabilityFidelity(state: AppState): Record<string, FidelityMark> {
  return structuredClone(state.portabilityFidelity ?? {});
}

/**
 * Запомнить оттиск, если он отличается от сохранённого. Возвращает `true`, когда
 * состояние действительно изменилось, — по нему вызывающий решает, писать ли
 * файл вообще.
 */
export function savePortabilityFidelity(state: AppState, key: string, mark: FidelityMark): boolean {
  const stored = state.portabilityFidelity?.[key];
  if (stored && sameFidelityPromise(stored, mark)) return false;
  state.portabilityFidelity ??= {};
  state.portabilityFidelity[key] = mark;
  return true;
}
