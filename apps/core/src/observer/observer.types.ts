import type { JournalLine, SignalAction } from '@agentdeck/contracts/core/journal';
import type { SignalId } from '@agentdeck/contracts/core/signal-view';

export type SignalSeverity = 'info' | 'warn' | 'stop';

/**
 * Решение наблюдателя (06 §Observer, класс `observer`): предикат над фактами журнала → сигнал.
 * `fired: false` — предикат не сработал, строк нет; иначе вызывающий пишет `decision` с этим
 * решением и строку `signal` с тем же `signal`/`severity`/`subject`/`detail`/`action`.
 */
export interface SignalDecision {
  fired: boolean;
  signal: string;
  severity: SignalSeverity;
  /**
   * Действие для дирижёра. `show` — только строка в журнале и панели: шаг идёт дальше (подмена
   * модели — факт для человека, а не повод ронять задачу на ложном срабатывании имени).
   */
  action: SignalAction;
  subject: string;
  detail: string;
  reasons: string[];
  /** Точка человека из каталога (только 5–7, 06:131); нет поля — судья её не выносит. */
  humanPoint?: 5 | 6 | 7 | null;
}

/**
 * Что увидел предикат (этап 8, F1): факт без серьёзности и действия — их даёт каталог через
 * единственного судью `judgeSignal`. Не `…Decision`: предикатов много, судья класса один (P01).
 * `key` — ключ повтора: решение с тем же ключом пишется один раз за жизнь задачи, перезапуск
 * ядра тоже его не повторит (ключи пересобираются из строк `decision{class:'observer'}`).
 * `escalated` — повтор после подсказки: каталог берёт ступень `escalated` своего сигнала.
 * `inputs` — строки журнала, на которых стоит вердикт (нет — строка, на которой он родился).
 */
export type SignalVerdict =
  | {
      fired: true;
      signal: string;
      subject: string;
      detail: string;
      reasons: string[];
      key: string;
      stepId?: string;
      sessionId?: string;
      escalated?: boolean;
      inputs?: number[];
    }
  | { fired: false; signal: string; reasons: string[] };

export type FiredVerdict = Extract<SignalVerdict, { fired: true }>;

/**
 * Что предикату приходит снаружи (пороги, окна маршрутов, время): `observer/**` не импортирует
 * экономику и обучение (`core-parts-apart`) — числа подаёт `bootstrap/observer-wiring`.
 */
export interface PredicateCtx {
  /**
   * Окно контекста маршрута × модели в токенах (факт `context` маршрута, тот же источник, что у
   * правила 60 % продолжения); `null` — неизвестно.
   */
  windowOf(routeId: string, model: string | null): number | null;
  /** Рабочее монотонное время ядра без сна машины (`CoreClock.activeMono`, P56). */
  now(): number;
}

/**
 * Предикат наблюдателя — чистая свёртка над строками журнала: своё состояние, строка → вердикты.
 * `ids` — сигналы, которые он может выдать (каждый обязан быть в каталоге).
 */
export interface Predicate<S = unknown> {
  readonly ids: readonly string[];
  init(): S;
  step(state: S, line: JournalLine, ctx: PredicateCtx): { state: S; verdicts: SignalVerdict[] };
}

/** Ступень сигнала: серьёзность и действие для дирижёра. */
export interface SignalLevel {
  severity: SignalSeverity;
  action: SignalAction;
}

/**
 * Самопроверка сигнала (P33): тест, где он срабатывает, и его почти-двойник, где молчит
 * (`file` + полный путь vitest «describe > it»). `null` в каталоге — ещё не названа (зона I).
 */
export interface SignalSelftest {
  file: string;
  fires: string;
  silent: string | null;
}

/**
 * Строка каталога сигналов (этап 8, F12): всё, что о сигнале решает ядро, а не предикат.
 * `kind: 'emitted'` — сигнал пишет свой владелец (модуль `owner`) по своему правилу, наблюдатель
 * его не выводит; `predicate` — выводит предикат из `observer/{waste,stall,integrity}`.
 * `severities` — каждая серьёзность, с которой строку пишут сегодня (у emitted их бывает две);
 * `severity` — ступень, с которой судит `judgeSignal` (у emitted — старшая из написанных).
 */
export interface SignalDef extends SignalLevel {
  /** Типизирован видом панели: сигнал без строки в `SIGNAL_VIEW` не собирается. */
  id: SignalId;
  kind: 'predicate' | 'emitted';
  owner: string;
  severities: readonly SignalSeverity[];
  /** Повтор после подсказки (`SignalVerdict.escalated`); нет — повтор судится как первый. */
  escalated?: SignalLevel;
  /** Точка человека, которую сигнал может поднять: только 5–7 (06:131); `null` — никакой. */
  humanPoint: 5 | 6 | 7 | null;
  /** Допустимая доля ложных срабатываний на библиотеке заглушек (F13: 0 — ложное = дефект). */
  fpThreshold: number;
  selftest: SignalSelftest | null;
  /**
   * Текст подсказки модели (английский, из каталога, не из предиката) — для `action: 'hint'`.
   * Берёт факты строки сигнала: дирижёр строит текст в конце хода из `SessionHint`.
   */
  hint?: (fact: HintFact) => string;
}

export interface HintFact {
  subject: string;
  detail: string;
}
