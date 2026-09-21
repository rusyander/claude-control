import type { TransferRecord } from '@agentdeck/contracts/portable-transfer';
import type { AppState } from './app-store.types.ts';

/**
 * След ПОСЛЕДНЕГО применённого переноса по паре «источник → цель» (П2.3).
 *
 * Без него кнопки «отменить перенос» не существует: список файлов и имён копий
 * живёт только здесь, а по каталогу копий его не восстановить — там лежат копии
 * всех правок панели вперемешку, и какие из них сделал один перенос, каталог не
 * помнит.
 *
 * В состоянии панели, а не в настройках, по той же причине, что и оттиск отчёта
 * верности: след называет пути файлов ЭТОЙ машины, и на другой означал бы чужие.
 *
 * Хранится ОДИН след на пару, последний. Отмена возвращает файлы к состоянию
 * перед ним — а история переносов вглубь была бы обещанием, которого панель не
 * держит: копии ротируются, и «отменить позапрошлый» упиралось бы в то, что
 * возвращать уже нечего.
 */

/** Ключ следа: пара CLI плюс уровень. Тот же вид, что у ключа отчёта верности. */
export function transferRecordKey(
  source: string,
  target: string,
  scope: string,
  /**
   * Идентификатор проекта на уровне проекта. Без него след переноса в проект А
   * и в проект Б лежал бы под одним ключом: кнопка отмены в Б вернула бы файлы
   * по путям А, а след А исчез бы молча.
   */
  project?: string,
): string {
  const base = `${source}->${target}:${scope}`;
  return project ? `${base}@${project}` : base;
}

export function getPortabilityTransfer(state: AppState, key: string): TransferRecord | undefined {
  const stored = state.portabilityTransfers?.[key];
  return stored ? structuredClone(stored) : undefined;
}

export function savePortabilityTransfer(
  state: AppState,
  key: string,
  record: TransferRecord,
): void {
  state.portabilityTransfers ??= {};
  state.portabilityTransfers[key] = record;
}

/**
 * Забыть след: перенос отменён целиком. Остаток (файлы, которые человек успел
 * изменить и не подтвердил) сохраняется обычной записью — отмена умеет быть
 * частичной, и след обязан это пережить.
 */
export function forgetPortabilityTransfer(state: AppState, key: string): void {
  if (!state.portabilityTransfers) return;
  delete state.portabilityTransfers[key];
}
