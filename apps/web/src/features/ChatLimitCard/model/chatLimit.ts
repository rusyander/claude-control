import type { ChatMessage, ProviderDetectResponse } from '@agentdeck/contracts';
import type { CarryCandidate, CarryPlan } from '@agentdeck/contracts/portable-carry';
import type { TaskView } from '@agentdeck/contracts/core/task-view';
import { offersOf, type WindowOffer } from '@entities/CoreTask';
import type { StreamState } from '@shared/lib/chat-stream';

/**
 * Карточка лимита чата (этап 12, L3, P171). Ход чата — шаг задачи ядра `chat@1`: окно подписки
 * отказало — ядро снимает сессию в конце хода и на сбросе открывает новую, отправляя последнее
 * слово человека ещё раз, ровно один раз (`core/conductor/run/chat-reopen.ts`). Панель в это время
 * не шлёт ничего: «Повторить» / «Продолжить» её прогона дали бы второй ход того же слова.
 */

/** Лимит держит ход: окно отказало, и ход этим кончился (новый ход сбрасывает ошибку). */
export function limitHolds(stream: Pick<StreamState, 'limitHit' | 'error'>): boolean {
  return Boolean(stream.limitHit && stream.error);
}

/**
 * Повтор панели при лимите выключен (P171): ядро само отправит слово после сброса, и повтор
 * панели поверх него — два хода одного слова. Без лимита обработчики проходят как есть.
 */
export function panelResend<T>(
  stream: Pick<StreamState, 'limitHit' | 'error'>,
  handler: T | undefined,
): T | undefined {
  return limitHolds(stream) ? undefined : handler;
}

/** Момент сброса (мс): вид задачи ядра знает точнее, иначе — событие окна потока (секунды). */
export function resetAtOf(
  stream: Pick<StreamState, 'limitResetsAt'>,
  view: TaskView | undefined,
): number | null {
  const fromView = view?.windowWait?.resetAt;
  if (typeof fromView === 'number') return fromView;
  return stream.limitResetsAt ? stream.limitResetsAt * 1000 : null;
}

/**
 * Ответ после сброса уже в ленте (P171): на сбросе ядро само шлёт слово ещё раз, и его ответ
 * приходит в историю разговора, а не в прогон панели — ошибка прогона с карточкой лимита иначе
 * висела бы над ответом до перезагрузки. Ответ модели не раньше момента сброса — это он: частичный
 * ответ отказанного хода всегда раньше сброса. Момент сброса неизвестен — карточка остаётся.
 */
export function answeredAfterReset(
  messages: readonly Pick<ChatMessage, 'role' | 'timestamp'>[],
  resetAt: number | null,
): boolean {
  if (resetAt === null) return false;
  return messages.some((m) => m.role === 'assistant' && Date.parse(m.timestamp) >= resetAt);
}

/** «чч:мм» на языке интерфейса, а не браузера. */
export function resetLabel(at: number, locale: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Куда перенести разговор (P171, решение этапа 12: предлагать каждый CLI с входом, переключать
 * только кликом). Перенос — дело панели (активный провайдер + перенос разговора), а не команда
 * задаче ядра, поэтому список строит панель по своему детекту: CLI стоит в PATH и его конфигурация
 * есть (вход чужого CLI панель не читает — конфигурация и есть след входа), кроме CLI разговора.
 * Варианты `cli:` ядра здесь не берутся: это CLI её разрешённого набора (собранные переходники
 * со своим входом, хоть и не установленные), а не цели переноса — у Codex, например, входа CLI в
 * наборе ядра нет вовсе, и чат его не предложил бы никогда.
 */
export function carryTargetsOf(
  detect: ProviderDetectResponse | undefined,
  current: string | undefined,
): WindowOffer[] {
  if (!detect || !current) return [];
  return detect.providers
    .filter((p) => p.cliInstalled && p.configPresent && p.id !== current)
    .map((p) => ({ option: `cli:${p.id}`, kind: 'cli', value: p.id }));
}

/** Варианты карточки: модели из вида задачи ядра (её окно знает их), затем цели переноса панели. */
export function chatOffers(view: TaskView | undefined, targets: WindowOffer[]): WindowOffer[] {
  const models = view?.windowWait ? offersOf(view).filter((o) => o.kind === 'model') : [];
  return [...models, ...targets];
}

/**
 * Этот разговор в плане переноса к новому CLI: ключ разговора (`sessionId` у Claude) или его id
 * в хранилище провайдера. Не нашёлся — переносить нечего, и это говорится, а не молчится.
 */
export function carryCandidateOf(
  plan: CarryPlan | undefined,
  conversationId: string | undefined,
): CarryCandidate | undefined {
  if (!plan || !conversationId) return undefined;
  return plan.candidates.find((c) => c.key === conversationId || c.chatId === conversationId);
}
