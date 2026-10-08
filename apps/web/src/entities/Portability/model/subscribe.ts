import type {
  SubscriptionDriftResolution,
  SubscriptionRowState,
} from '@agentdeck/contracts/portable-subscribe';
import type { BadgeTone } from '@shared/ui/badge';

/**
 * Показ подписки и расхождений (П5.1, П5.2).
 *
 * Словари закрыты по типу — тем же приёмом, что у исходов переноса и уровней
 * верности: состояние, добавленное в контракт и забытое здесь, не соберётся,
 * вместо того чтобы тихо приехать на экран серой меткой со своим английским
 * кодом.
 */

/**
 * Цвет состояния строки несёт ровно одно: тронет ли пересборка эту запись.
 *
 * `gone` — жёлтое, а не красное: запись исчезла из канона, и у цели она
 * осталась. Это разговор, а не беда — снять её у чужого CLI подписка не умеет
 * и не должна уметь молча.
 */
export const ROW_STATE_TONE: Record<SubscriptionRowState, BadgeTone> = {
  new: 'info',
  changed: 'accent',
  unchanged: 'neutral',
  gone: 'warning',
};

/**
 * Порядок показа — от того, что изменится, к тому, что не изменится. Совпавшие
 * строки идут последними, но показываются наравне: список без них человек
 * прочитал бы как «в каноне только это», а в нём — вся подписанная среда.
 */
export const ROW_STATE_ORDER: readonly SubscriptionRowState[] = [
  'new',
  'changed',
  'gone',
  'unchanged',
];

export function rowStateLabelKey(state: SubscriptionRowState): string {
  return `portability.subscription.state.${state}`;
}

/**
 * Порядок исходов расхождения — от сохраняющего правку человека к снимающему
 * подписку. `projection` вторым НАМЕРЕННО: он единственный, который правку
 * теряет, и стоять первым он не может по той же причине, по которой у переноса
 * нет кнопки «перенести» до показанного плана.
 */
export const RESOLUTION_ORDER: readonly SubscriptionDriftResolution[] = [
  'canon',
  'projection',
  'unsubscribe',
];
