import type { EnvItemKind } from '@agentdeck/contracts/portable-env';
import type {
  EnvSubscription,
  SubscriptionDriftResolution,
  SubscriptionDriftState,
  SubscriptionHoldReason,
  SubscriptionRebuildReason,
  SubscriptionRow,
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

export function holdLabelKey(reason: SubscriptionHoldReason): string {
  return `portability.subscription.hold.${reason}`;
}

export function rebuildLabelKey(reason: SubscriptionRebuildReason): string {
  return `portability.subscription.rebuild.${reason}`;
}

export function driftStateLabelKey(state: SubscriptionDriftState): string {
  return `portability.subscription.drift.state.${state}`;
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

export function resolutionLabelKey(resolution: SubscriptionDriftResolution): string {
  return `portability.subscription.resolution.${resolution}.title`;
}

export function resolutionTextKey(resolution: SubscriptionDriftResolution): string {
  return `portability.subscription.resolution.${resolution}.text`;
}

/** Сводка строк пересборки: сколько записей в каждом состоянии и сколько удержано. */
export interface RowsSummary {
  readonly counts: Record<SubscriptionRowState, number>;
  /**
   * Записи, которые НЕ поедут, потому что их файл тронут рукой. Считается
   * отдельно от состояний намеренно: «изменилась» и «изменилась, но не поедет» —
   * разные ответы, и сложи мы их в одно число, человек прочитал бы удержанное
   * как записанное (П5.2).
   */
  readonly held: number;
}

/**
 * Сколько записей в каждом состоянии. Считается ИЗ строк, а не берётся полем
 * ответа: число, за которым на экране нет строк, — то же самое число без
 * основания.
 */
export function summarizeRows(rows: readonly SubscriptionRow[]): RowsSummary {
  const counts: Record<SubscriptionRowState, number> = {
    new: 0,
    changed: 0,
    unchanged: 0,
    gone: 0,
  };
  let held = 0;
  for (const row of rows) {
    counts[row.state] += 1;
    if (row.heldBy) held += 1;
  }
  return { counts, held };
}

/**
 * Подписка выбранной цели на выбранном уровне — из общего списка.
 *
 * Уровень входит в поиск наравне с целью: подписка дома и подписка проекта —
 * РАЗНЫЕ подписки с разными корнями, и показать одну под заголовком другой
 * значило бы предложить пересобрать не те файлы.
 */
export function findSubscription(
  items: readonly EnvSubscription[],
  target: string,
  scope: string,
  project = '',
): EnvSubscription | null {
  return (
    items.find(
      (item) => item.target === target && item.scope === scope && (item.project ?? '') === project,
    ) ?? null
  );
}

/**
 * Подписана ли цель хоть на что-нибудь.
 *
 * Отдельно от «запись подписки есть»: запись переживает отписку намеренно — в
 * ней лежит память о спроецированном, — и считать её наличие подпиской значило
 * бы показывать пересборку там, где человек от всего отписался.
 */
export function hasLayers(subscription: EnvSubscription | null): boolean {
  return Boolean(subscription && subscription.layers.length > 0);
}

/** Подписан ли слой. Пустая подписка отвечает «нет» на каждый. */
export function isLayerOn(subscription: EnvSubscription | null, layer: EnvItemKind): boolean {
  return Boolean(subscription?.layers.includes(layer));
}

/**
 * Набор слоёв после щелчка по одному. Порядок сохраняется от `KIND_ORDER`, а не
 * от порядка щелчков: сервер хранит список как есть, и без этого два одинаковых
 * набора отличались бы порядком — то есть выглядели бы разными подписками в
 * каждом сравнении.
 */
export function toggleLayer(
  layers: readonly EnvItemKind[],
  layer: EnvItemKind,
  order: readonly EnvItemKind[],
): EnvItemKind[] {
  const next = layers.includes(layer)
    ? layers.filter((kept) => kept !== layer)
    : [...layers, layer];
  // Вид, которого в порядке экрана нет, дописывается в конец, а не пропадает:
  // фильтр по списку экрана снимал подписку со всего, о чём этот список забыл, —
  // щелчок по соседнему слою молча отписывал бы от целого вида.
  const unknown = next.filter((kind) => !order.includes(kind));
  return [...order.filter((kind) => next.includes(kind)), ...unknown];
}
