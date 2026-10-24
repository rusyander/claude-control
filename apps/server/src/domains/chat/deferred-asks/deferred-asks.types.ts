import type {
  DeferredAskKind,
  DeferredAskSource,
  DeferredAskState,
  DeferredReasonCode,
  DeferredReasonParams,
  DeferredScope,
  DeferredVia,
} from '@agentdeck/contracts/deferred-asks';

/** Запись в файле `appData/deferred-asks.json`. */
export interface DeferredAskRecord {
  id: string;
  state: DeferredAskState;
  kind: DeferredAskKind;
  scope: DeferredScope;
  /** Ключи прогона, где спросили: открыть разговор, снять карточку. */
  runKeys: string[];
  toolName: string;
  /**
   * Вход вызова ЦЕЛИКОМ: продолжение называет агенту ровно его, иначе новый
   * разговор (доставка, после паузы) не повторил бы вызов знак в знак и
   * разрешение не совпало бы. Наружу — только `summary` под маской.
   */
  input: unknown;
  hash: string;
  /** Вызов, на котором спросили: кнопки карточки в ленте отвечают этой записи. */
  toolUseId?: string;
  reason: string;
  /** Причина для человека кодом — `reason` написан для агента по-английски. */
  reasonCode?: DeferredReasonCode;
  reasonParams?: DeferredReasonParams;
  askedAt: string;
  expiresAt: string;
  /** Повторы того же вызова, пока запись ждала, — их отбивают без новой записи. */
  retries?: number;
  decidedAt?: string;
  decidedVia?: DeferredVia;
  message?: string;
  grantUntil?: string;
  consumedAt?: string;
  resumedAt?: string;
  /**
   * Слово разговору о НЫНЕШНЕМ исходе записи (разрешено, отказано, истекло) дошло.
   * Снимается при каждой смене исхода. Нет его у решённой или истёкшей записи —
   * слово ещё должно уйти, в том числе после перезапуска панели: очередь слов
   * живёт в памяти, и иначе отказ или истечение терялись бы с ней (RF-DL-04).
   */
  toldAt?: string;
  /** Конец жизни записи (решение, срок, отзыв) — от него считаются сутки до уборки. */
  closedAt?: string;
  /** Каталог прогона: ворота ветки одиночного чата снимаются по нему. */
  cwd?: string;
  source: DeferredAskSource;
}

export interface DeferredAskFile {
  /** 2 — у записей есть `toldAt`; файл версии 1 при чтении переводится (`store.ts`). */
  version: 2;
  /** Следующий номер: счёт сквозной и переживает уборку, номера не повторяются. */
  next: number;
  records: DeferredAskRecord[];
}

/** Что записать: вызов, который решает только человек. */
export interface DeferredAskInput {
  scope: DeferredScope;
  runKeys: string[];
  toolName: string;
  input: unknown;
  toolUseId?: string;
  reason: string;
  reasonCode?: DeferredReasonCode;
  reasonParams?: DeferredReasonParams;
  kind?: DeferredAskKind;
  cwd?: string;
  source?: DeferredAskSource;
}

/**
 * Итог `ask`: новая запись, уже ждущая (повтор того же вызова) или уже
 * отказанная человеком. Повтор никогда не заводит новой записи.
 */
export type DeferredAskOutcome =
  | { kind: 'created'; record: DeferredAskRecord }
  | { kind: 'queued'; record: DeferredAskRecord }
  | { kind: 'refused'; record: DeferredAskRecord };

export interface DeferredDecisionInput {
  behavior: 'allow' | 'deny';
  message?: string;
  via: DeferredVia;
}

export interface DeferredDecisionOutcome {
  record: DeferredAskRecord;
  /** `false` — уже решено раньше: повторный клик ничего не меняет. */
  changed: boolean;
}

export interface DeferredAsksDeps {
  /** Файл записи; нет — только память (юниты). */
  file?: string;
  now?: () => number;
  /** Срок ожидания записи, мс (настройка, по умолчанию 7 суток). */
  ttlMs?: () => number;
  /** Срок разрешения после решения, мс (2 ч). */
  grantMs?: number;
  log?: (message: string, detail?: unknown) => void;
}

export type DeferredListener = (record: DeferredAskRecord) => void;
