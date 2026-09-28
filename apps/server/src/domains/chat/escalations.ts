import { scanEscalateBlocks } from '@agentdeck/contracts/chat-escalate';
import type { EscalationNotice, RecommendedPick } from '@agentdeck/contracts/chat-group-settings';
import type { ChatEvent } from './chat-events.ts';

/**
 * Критическое замечание ребёнка — карточкой в ГЛАВНЫЙ чат дерева.
 *
 * Поводов два: ребёнок сказал сам (блок `agentdeck:escalate` в ответе) или
 * автономия взяла за человека вопрос с заголовком `critical`. Некритическое
 * остаётся в самом ребёнке — главный чат читает человек, и шум там стоит
 * внимания, которое нужно на настоящее.
 *
 * Правда о заметках — у хранилища панели: карточку показывает список заметок
 * корня (`GET /api/chat/escalations`), а событие в ленту корня и рассылка
 * `chat-escalations` лишь будят того, кто смотрит. Поэтому корень без идущего
 * прогона (или в чужом CLI, где событию некуда лечь) заметку не теряет.
 */
export interface EscalationDeps {
  /** Настоящий ключ разговора по любому его написанию. */
  canonical: (key: string) => string;
  /** Родитель по связи разделения; нет — корень. */
  parentOf: (key: string) => string | undefined;
  /** Подпись ребёнка: название группы из предложения. */
  titleOf: (key: string) => string | undefined;
  /** Главный чат дерева по ключам разговора. */
  rootOf: (keys: readonly string[]) => string;
  /** Записать заметку; `false` — такая уже есть. */
  store: (root: string, notice: EscalationNotice) => boolean;
  /** Событие в ленту корня. */
  say: (root: string, event: ChatEvent) => boolean;
  /** Разбудить открытые окна: список заметок сменился. */
  changed: () => void;
  now?: () => string;
}

export interface Escalations {
  /** Конец хода ребёнка: блоки замечаний из его ответа. */
  fromReply: (keys: readonly string[], text: string) => number;
  /** Автовыбор в ребёнке: критичные вопросы. */
  fromPicks: (keys: readonly string[], picks: readonly RecommendedPick[]) => number;
}

export function createEscalations(deps: EscalationDeps): Escalations {
  const now = deps.now ?? (() => new Date().toISOString());

  /**
   * Ребёнок ли это — у корня дерева заметок нет: главный чат и так тот, что
   * человек читает, и карточка «в себе самом» только дублировала бы ответ.
   */
  const placeOf = (keys: readonly string[]) => {
    const present = keys.filter(Boolean);
    if (present.length === 0) return undefined;
    const hasParent = present.some((key) => deps.parentOf(key) !== undefined);
    if (!hasParent) return undefined;
    const root = deps.canonical(deps.rootOf(present));
    const childChatId = deps.canonical(present.at(-1) ?? '');
    if (!root || root === childChatId) return undefined;
    const title = present.map(deps.titleOf).find((value) => Boolean(value)) ?? childChatId;
    return { root, childChatId, title };
  };

  const record = (
    keys: readonly string[],
    items: readonly { text: string; source: EscalationNotice['source'] }[],
  ): number => {
    if (items.length === 0) return 0;
    const place = placeOf(keys);
    if (!place) return 0;
    let added = 0;
    for (const item of items) {
      const notice: EscalationNotice = {
        childChatId: place.childChatId,
        childTitle: place.title,
        text: item.text,
        source: item.source,
        at: now(),
      };
      if (!deps.store(place.root, notice)) continue;
      added += 1;
      deps.say(place.root, { kind: 'escalation', notice });
    }
    if (added > 0) deps.changed();
    return added;
  };

  return {
    fromReply: (keys, text) =>
      record(
        keys,
        scanEscalateBlocks(text).blocks.map((block) => ({ text: block.text, source: 'block' })),
      ),
    fromPicks: (keys, picks) =>
      record(
        keys,
        picks
          .filter((pick) => pick.critical)
          .map((pick) => ({ text: `${pick.question} → ${pick.label}`, source: 'auto-pick' })),
      ),
  };
}
