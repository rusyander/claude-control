import { runs } from './agent-runs.state';
import type { QueuedMessage } from './agent-runs.types';

const PREFIX = 'claude-control:chat-queue:';

/**
 * Дольше этого срока сохранённая очередь считается протухшей и не досылается.
 *
 * Очередь — это «скажи ему вот ещё что, как освободится», а не письмо на завтра.
 * Панель, открытая через сутки, не должна сама поднимать агента ради реплики,
 * про которую человек давно забыл: показанное на экране он ждёт увидеть в том
 * разговоре, который сейчас перед ним, а не услышать эхо позавчерашнего.
 */
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

interface StoredQueue {
  savedAt: number;
  items: QueuedMessage[];
}

/**
 * Очередь дописанного — в localStorage, рядом с черновиком поля ввода.
 *
 * До этого она жила только в памяти вкладки: перезагрузка страницы (своя же
 * правка фронта, обновление по F5, перезапуск панели) стирала уже написанное
 * бесследно — ни в ленте, ни в транскрипте, ни в поле ввода. Хранилище
 * обёрнуто в try/catch по той же причине, что и черновики: в приватном режиме
 * или при переполнении оно кидается, а ронять из-за этого чат нельзя.
 *
 * Вложения складываем как есть. Не поместились в квоту — запись просто не
 * состоится, и очередь останется памятью вкладки, как была: молча ронять
 * файлы, оставляя текст, значит отправить агенту не то сообщение.
 */
function read(id: string): QueuedMessage[] {
  try {
    const raw = localStorage.getItem(PREFIX + id);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredQueue;
    if (!Array.isArray(parsed.items) || parsed.items.length === 0) return [];
    if (!(typeof parsed.savedAt === 'number') || Date.now() - parsed.savedAt > MAX_AGE_MS) {
      remove(id);
      return [];
    }
    return parsed.items;
  } catch {
    return [];
  }
}

function remove(id: string): void {
  try {
    localStorage.removeItem(PREFIX + id);
  } catch {
    // См. комментарий выше: хранилище может быть недоступно.
  }
}

/**
 * Сохранить очередь разговора. Первый непустой id — основной (обычно
 * `sessionId`, он переживает перезагрузку); остальные написания того же
 * разговора стираем, чтобы одна очередь не читалась дважды.
 */
export function saveQueue(ids: (string | undefined)[], items: QueuedMessage[]): void {
  const known = ids.filter((id): id is string => Boolean(id));
  const primary = known[0];
  if (!primary) return;
  for (const id of known.slice(1)) remove(id);
  if (items.length === 0) {
    remove(primary);
    return;
  }
  try {
    const payload: StoredQueue = { savedAt: Date.now(), items };
    localStorage.setItem(PREFIX + primary, JSON.stringify(payload));
  } catch {
    // Не поместилось — очередь остаётся в памяти вкладки.
  }
}

/** Прочитать сохранённую очередь по любому из написаний разговора. */
export function loadQueue(...ids: (string | undefined)[]): QueuedMessage[] {
  for (const id of ids) {
    if (!id) continue;
    const items = read(id);
    if (items.length > 0) return items;
  }
  return [];
}

/** Забыть сохранённую очередь разговора (ушла, отменена или протухла). */
export function forgetQueue(...ids: (string | undefined)[]): void {
  for (const id of ids) if (id) remove(id);
}

/**
 * Записать очередь прогона такой, какая она сейчас в сторе.
 *
 * Основным написанием берём `sessionId`: временный `new-…` живёт до первого
 * события потока и после перезагрузки не значит ничего, а сохранённая под ним
 * очередь стала бы недостижимой.
 */
export function persistQueue(key: string): void {
  const run = runs.get(key);
  saveQueue([run?.sessionId, key], run?.queued ?? []);
}
