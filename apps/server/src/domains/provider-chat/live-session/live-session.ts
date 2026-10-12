import { createHash } from 'node:crypto';
import type { ProviderChatMessage } from '@agentdeck/contracts';

/**
 * Сессия чужого CLI между ходами разговора (E2b): что о ней помнит панель и
 * когда её можно продолжить.
 *
 * Живой ход (`live/`) умеет оставить сессию CLI после ответа и поднять её
 * следующим ходом — тогда CLI получает только реплики, которых ещё не видел, а
 * не всю переписку заново. Продолжать её можно, лишь пока то, что CLI видел,
 * совпадает с перепиской панели. Поэтому отметка хранит отпечаток увиденного, и
 * любое расхождение — правка или удаление реплики, другая модель, другой каталог,
 * другое системное указание — открывает новую сессию с полной перепиской, а
 * прежняя удаляется. Ошибиться в сторону «начать заново» дёшево (это прежнее
 * поведение), в сторону «продолжить» — нельзя: модель отвечала бы на разговор,
 * которого человек не видит.
 */

/** Отметка разговора о сессии CLI: соседний файл переписки (`store.ts`). */
export interface ProviderChatLiveSession {
  /** Протокол живого хода (`liveServer` каталога): сессия одного CLI другому не годится. */
  kind: string;
  /** id сессии у самого CLI. */
  id: string;
  /**
   * Ход с этой сессией кончился не ответом: продолжать её нельзя, следующий ход
   * откроет новую и эту удалит. Остальные поля у такой отметки не читаются.
   */
  stale?: true;
  /** Сколько реплик переписки от её начала сессия уже видела. */
  covered?: number;
  /** Отпечаток этих реплик (`digestMessages`). */
  digest?: string;
  /** Отпечаток постоянной части промпта (`digestPreamble`). */
  preamble?: string;
  /** Модель и каталог хода: другие — другая сессия. Пусто — настройка CLI / каталог сервера. */
  model?: string;
  workdir?: string;
}

/** Что ход получает о прежней сессии разговора. */
export interface LiveSessionPrevious {
  kind: string;
  id: string;
  /** Нет — продолжать нельзя, только удалить. */
  covered?: number;
  preamble?: string;
}

/**
 * Отпечаток реплик. Входит всё, что делает реплику ею: id, роль, текст и
 * пометка провала — неудавшийся ответ в контекст CLI не шёл, и смена этой
 * пометки меняет то, что модель видела.
 */
export function digestMessages(messages: readonly ProviderChatMessage[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(
      JSON.stringify([message.id, message.role, message.content, message.failed === true]),
    );
    hash.update('\n');
  }
  return hash.digest('hex');
}

/** Отпечаток постоянной части промпта: системное указание и каталог скиллов. */
export function digestPreamble(blocks: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
}

/**
 * Можно ли продолжить сессию разговора этим ходом. Сверяется всё, что знает
 * служба: модель, каталог и то, что первые `covered` реплик переписки — ровно
 * те, что видела сессия. Постоянную часть промпта сверяет сам прогон: её
 * собирает он. `undefined` — отметки нет, ход откроет первую сессию.
 */
export function planLiveSession(
  mark: ProviderChatLiveSession | undefined,
  current: { messages: readonly ProviderChatMessage[]; model: string; workdir: string },
): LiveSessionPrevious | undefined {
  if (!mark) return undefined;
  const drop = { kind: mark.kind, id: mark.id };
  const { covered, digest, preamble } = mark;
  if (mark.stale || covered === undefined || digest === undefined || preamble === undefined) {
    return drop;
  }
  if ((mark.model ?? '') !== current.model || (mark.workdir ?? '') !== current.workdir) {
    return drop;
  }
  if (covered < 1 || covered > current.messages.length) return drop;
  if (digestMessages(current.messages.slice(0, covered)) !== digest) return drop;
  return { ...drop, covered, preamble };
}
