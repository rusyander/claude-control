import type { PlatformStatus } from '@agentdeck/contracts';

/**
 * Состояние карточки одним словом — то, по чему ветвится показ.
 *
 * `unchecked` отделён от `unreachable` намеренно: «не проверяли» и «не
 * отвечает» — разные утверждения, и второе про контур, который может работать.
 */
export type PlatformCardState =
  'disabled' | 'unchecked' | 'ok' | 'unauthorized' | 'unreachable' | 'no-key';

export function platformCardState(status: PlatformStatus): PlatformCardState {
  // Признак ровно один — `active`. Тумблер контура говорит о том же самом
  // (инвариант 1), но это ВТОРОЙ источник одного факта, и разойтись они могут:
  // настройки приезжают чужими писателями (снимок, архив переноса), и до
  // сведения панель показывала бы «на связи» с кнопкой «сделать активным» тому
  // контуру, который шлюз уже обслуживает. `disabled` здесь читается как
  // «работа идёт не через него».
  if (!status.active) return 'disabled';
  if (!status.health) return 'unchecked';
  if (status.health.outcome === 'ok') return 'ok';
  if (status.health.outcome === 'unauthorized') return 'unauthorized';
  // Проба шла без ключа: адрес подтверждён, отклонять было нечего.
  if (status.health.outcome === 'no-key') return 'no-key';
  return 'unreachable';
}
