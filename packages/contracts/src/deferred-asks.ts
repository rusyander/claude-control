/**
 * Отложенный вопрос человеку («D-n») — общий словарь сервера, окна и телефона.
 *
 * Зачем он есть. Владелец уходит от панели на часы, а группа (и одиночный чат)
 * не имеет права стоять на нём: то, что вправе решить только человек (слияние в
 * main — нет, это отказ агенту; запись в БД, удаление вне копии, учётные данные,
 * публикация пакета…), отбивается СРАЗУ текстом «поставлено человеку как D-7»,
 * агент продолжает остальную работу, а человек позже отвечает из одного списка.
 * Ответ «разрешить» продолжает разговор с разовым разрешением ровно этого вызова.
 *
 * Модуль без импортов: телефон собирает контракты-значения без zod
 * (`apps/mobile/metro.config.js`, VALUE_MODULES), а разбор метки отказа нужен и
 * ему (лента), и серверу (реестр, исход хода), и окну. Схема тела решения — в
 * `request-bodies.ts`, рядом со схемами остальных решений.
 */

/** Состояние записи. `allowed` — разрешение выдано и ещё не использовано. */
export type DeferredAskState =
  'waiting' | 'allowed' | 'denied' | 'expired' | 'consumed' | 'withdrawn';

export const DEFERRED_ASK_STATES: readonly DeferredAskState[] = [
  'waiting',
  'allowed',
  'denied',
  'expired',
  'consumed',
  'withdrawn',
];

/** Что отложено: запрос прав или ворота ветки одиночного чата. */
export type DeferredAskKind = 'permission' | 'branchGate';

/** Откуда пришёл ответ человека. */
export type DeferredVia = 'web' | 'mobile' | 'telegram';

/**
 * Чьё это: группа разделения (`parentChatId` + номер) или одиночный чат (его
 * ключи). Разрешение действует на всю группу, а не на сессию: доставка и
 * продолжение после паузы — НОВЫЕ разговоры той же группы.
 */
export type DeferredScope =
  | { kind: 'group'; parentChatId: string; groupIndex: number }
  | { kind: 'chat'; chatKeys: string[] };

/**
 * Почему это решает человек — кодом: текст `reason` написан для агента
 * (по-английски, его читает модель), а человек читает причину на языке
 * панели. Нет кода (запись старше) — клиент показывает `reason` как есть.
 */
export type DeferredReasonCode = 'group-rows' | 'not-auto-approved' | 'backend-guard' | 'main-copy';

/** Подробности причины `backend-guard`: правило защиты и что совпало. */
export interface DeferredReasonParams {
  rule?: string;
  match?: string;
}

/** Подпись для человека: где это спросили. */
export interface DeferredAskSource {
  project?: string;
  projectPath?: string;
  chatTitle?: string;
  /** Номер группы с единицы — как в хабе. */
  group?: number;
  groupTitle?: string;
  stage?: string;
}

/** Запись так, как её видит человек (`GET /api/chat/deferred`, сводка, телефон). */
export interface DeferredAskView {
  id: string;
  state: DeferredAskState;
  kind: DeferredAskKind;
  scope: DeferredScope;
  toolName: string;
  /** Что именно будет сделано — команда или путь, секреты под маской. */
  summary: string;
  /**
   * Что впишется в файл (`Write` — текст, `Edit` — было/стало): у этих
   * инструментов в сводке только путь, и человек разрешал, не видя байтов.
   * Урезано с обоих концов и под маской; право по-прежнему привязано к входу
   * целиком (D-S03).
   */
  detail?: string;
  /** Почему это решает человек — та же причина, что в тексте отказа агенту. */
  reason: string;
  reasonCode?: DeferredReasonCode;
  reasonParams?: DeferredReasonParams;
  askedAt: string;
  expiresAt: string;
  /** Сколько раз агент повторил тот же вызов, пока запись ждала. */
  retries?: number;
  decidedAt?: string;
  decidedVia?: DeferredVia;
  message?: string;
  /** До какого времени действует разрешение (только `allowed`). */
  grantUntil?: string;
  resumedAt?: string;
  /** Ключ разговора, где спросили, — открыть его из списка. */
  chatId?: string;
  source: DeferredAskSource;
}

export interface DeferredAskList {
  generatedAt: string;
  items: DeferredAskView[];
}

/** Ответ маршрута решения: состояние записи после него. */
export interface DeferredDecisionResult {
  item: DeferredAskView;
  /** `false` — запись уже решена раньше, и решение не изменилось (повторный клик). */
  changed: boolean;
  /** Продолжение разговора: заведено, ждёт конца идущего хода, или его некуда завести. */
  resume?: 'sent' | 'queued' | 'parked' | 'none';
}

/** Номер записи: `D-<n>`. */
export const DEFERRED_ID = /^D-[1-9]\d{0,8}$/;

/** Начало текста отказа «поставлено человеку» — по нему узнают отказ лента, реестр и исход хода. */
export const DEFERRED_MARKER = 'agentdeck(deferred ';

/** Начало отказа панели с известным ответом (слияние, правка основной копии группой…). */
export const PANEL_REFUSAL_MARKER = 'agentdeck(refused)';

const MARKED = /^agentdeck\(deferred (D-[1-9]\d{0,8})\)/;
const MENTION = /(?<![\w-])D-([1-9]\d{0,8})(?![\w-])/g;
/** Строка конца хода «Waiting for the human: D-7 — …», которую просит текст отказа. */
const WAIT_LINE =
  /^[\s>*_`-]*(?:waiting\s+for\s+the\s+human|ждёт\s+решения|ждет\s+решения|ждёт\s+человека)\b[^\n]*\bD-[1-9]\d{0,8}\b[^\n]*$/gimu;

/** Номер записи, если текст — отказ «поставлено человеку» (любой из трёх вариантов). */
export function deferredIdOf(text: string): string | undefined {
  return MARKED.exec(text.trimStart())?.[1];
}

/** Отказ панели с известным ответом — не вопрос человеку. */
export function isPanelRefusal(text: string): boolean {
  return text.trimStart().startsWith(PANEL_REFUSAL_MARKER);
}

/** Все номера `D-n`, названные в тексте, — без повторов, в порядке появления. */
export function deferredIdsIn(text: string): string[] {
  const seen = new Set<string>();
  for (const match of text.matchAll(MENTION)) seen.add(`D-${match[1]}`);
  return [...seen];
}

/**
 * Текст без строк «Waiting for the human: D-7 — …»: остаток судят обычным
 * правилом «ждёт ли ход ответа». Ход, где кроме этих строк вопроса нет, — законное
 * ожидание решения, а не вопрос, на который панель отвечает за человека.
 */
export function withoutDeferredWaitLines(text: string): string {
  return text.replace(WAIT_LINE, '').trim();
}
