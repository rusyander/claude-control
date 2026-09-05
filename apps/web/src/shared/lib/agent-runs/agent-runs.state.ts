import type { MessageUsage } from '@claude-control/contracts';
import { EMPTY_RUN } from './agent-runs.constants';
import type { AgentRun, HandoffEvent } from './agent-runs.types';

/**
 * Живое состояние стора: сами прогоны, их потоки и подписчики. Лежит в модуле, а
 * не в React-состоянии, потому что прогон переживает и смену таба, и размонтаж
 * страницы; компоненты подключаются к нему через `useSyncExternalStore`.
 */

export const runs = new Map<string, AgentRun>();
export const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

/** Последний полученный seq по прогону — точка догоняния при переподключении. */
export const lastSeqs = new Map<string, number>();

/**
 * Прогоны, чей хвост уже дотянут: серверный ключ → `startedAt`.
 *
 * Сервер держит законченный прогон в `/chat/active` ещё минуту (grace), а стор
 * после перечитки истории убирает его запись — без этой памяти каждый такт
 * опроса подхватывал бы тот же прогон заново: снова поток, снова перечитка
 * ленты. Новый ход в том же разговоре приходит с другим `startedAt` — его
 * берём. Пишется при закрытии любого прогона, читается при подхвате.
 */
export const caughtUp = new Map<string, number | undefined>();

/**
 * Расход шага, пришедший раньше своих вызовов: прогон → id вызова → расход.
 *
 * Сервер отдаёт usage сообщения ДО его же tool_use-блоков, поэтому в момент
 * прихода расхода привязывать его ещё не к чему. Хранится вне снимка прогона:
 * это служебная переписка событий, перерисовывать по ней ленту незачем.
 */
export const pendingUsage = new Map<string, Map<string, MessageUsage>>();

/**
 * Отправки, чей ответ сервера ещё не пришёл. Такой поток отпускать нельзя:
 * обрыв запроса до ответа — это непринятое сообщение, а не отпущенный поток.
 */
export const sending = new Set<string>();

/** Счётчик мест в очереди: два сообщения в одну миллисекунду тоже различимы. */
let queueCounter = 0;

export function nextQueueSeq(): number {
  return queueCounter++;
}

/**
 * Внешние подключения стора: колбэки страницы и id открытого чата. Собраны в
 * один объект, чтобы читаться из любого модуля стора по живой ссылке.
 */
export const callbacks: {
  onFinished?: () => void;
  onBackgroundEvent?: (run: AgentRun) => void;
  /** Новый запрос прав по любому прогону — для карточки, звука и тоста. */
  onPermissionRequest?: (run: AgentRun) => void;
  /**
   * Работа уехала в чистую сессию (или отказ с причиной). Отдаём и сам прогон:
   * продолжиться мог ЛЮБОЙ из идущих, а переезжать вкладке нужно только за
   * своим — сравнивать есть с чем только имея закрытый разговор на руках.
   */
  onHandoff?: (event: HandoffEvent, run: AgentRun) => void;
  /** Чат, открытый на экране: его завершение не уведомляем — пользователь и так видит. */
  activeId?: string;
  /**
   * Пересчитать, кому достаются потоки (`agent-runs.slots`). Через колбэк,
   * а не импортом: слоты сами зовут `runStream`, и прямой импорт из
   * жизненного цикла замкнул бы круг.
   */
  rebalance?: () => void;
} = {};

export function emit(): void {
  for (const listener of listeners) listener();
}

export function setRun(id: string, patch: Partial<AgentRun>): void {
  const current = runs.get(id) ?? { ...EMPTY_RUN, id };
  runs.set(id, { ...current, ...patch });
}

/**
 * Ключ прогона по id чата. Новый чат стартует под временным id (`new-…`), а
 * потом получает настоящий sessionId; чтобы отображение не потеряло прогон при
 * смене id, ищем и по sessionId.
 */
export function findKey(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (runs.has(id)) return id;
  for (const [key, run] of runs) if (run.sessionId === id) return key;
  return undefined;
}

export function getRun(id: string | undefined): AgentRun {
  const key = findKey(id);
  return (key && runs.get(key)) || EMPTY_RUN;
}

export function subscribeRuns(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
