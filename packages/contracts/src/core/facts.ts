/**
 * Факт внешнего мира (01 §Facts, F25): значение, «нет» или «неизвестно с причиной». Любое
 * исключение и таймаут — `unknown`, никогда `absent`: «не смог прочитать» и «прочитал — нет»
 * ведут к разным решениям (P44).
 */
export type Fact<T> = { value: T } | { absent: true } | { unknown: string };

/** Что делает решение, если вход `unknown` (01 §Facts): никогда «пропустить» и никогда «нет». */
export const UNKNOWN_ACTIONS = ['run', 'ask', 'refuse', 'retry-until'] as const;
export type UnknownAction = (typeof UNKNOWN_ACTIONS)[number];

export interface ReadClassDef {
  name: string;
  /** Свой таймаут у каждого класса — не общий с быстрой пробой «изменилось ли». */
  timeoutMs: number;
  onUnknown: UnknownAction;
  /** Для `retry-until`: сколько повторять до точки человека. */
  retryUntilMs?: number;
  /** Пока класс — заглушка будущей фазы, она названа. */
  stubUntilPhase?: number;
}

/**
 * Классы чтения этапа 4 (дирижёр) — контракт, к которому привязан реестр ядра
 * (`Phase4ReadClassesBound` в `lib/facts/read-classes.ts`): срок или действие разошлись — ошибка
 * сборки. Буква — зона, которая читает и держит тест сбоя P44 по своему классу.
 */
export type Phase4ReadClasses = {
  'scenario.library': { timeoutMs: 5_000; onUnknown: 'refuse' }; // A, дом ядра
  'scenario.project': { timeoutMs: 5_000; onUnknown: 'refuse' }; // A, нечитаемый ≠ нет файла
  'layer.settings': { timeoutMs: 5_000; onUnknown: 'run' }; // A, сверка копии: unknown — без правки, названо
  'requirements.source': { timeoutMs: 5_000; onUnknown: 'refuse' }; // C, артефакт запроса
  'git.diff-unit': { timeoutMs: 30_000; onUnknown: 'refuse' }; // C, без диффа нет вывода «готово»
  'git.history': { timeoutMs: 30_000; onUnknown: 'run' }; // D, подсказки владения
  'git.fetch-base': { timeoutMs: 60_000; onUnknown: 'run' }; // D, приколота локальная ссылка, названо
  'durations.learned': { timeoutMs: 10_000; onUnknown: 'run' }; // D, оценка null
  'git.status': { timeoutMs: 15_000; onUnknown: 'run' }; // E P69, бриф говорит «не прочитано»
};

/** Классы чтения этапа 6 (публикация); буква — зона: F форж, G страж, P публикатор. */
export type Phase6ReadClasses = {
  'git.ls-remote': { timeoutMs: 30_000; onUnknown: 'retry-until' }; // G конец шага, F читатель пуша
  'git.worktree-config': { timeoutMs: 5_000; onUnknown: 'refuse' }; // G дрейф закрытия
  'git.merge-tree': { timeoutMs: 60_000; onUnknown: 'refuse' }; // P синхронизация с базой
  'forge.activity': { timeoutMs: 30_000; onUnknown: 'run' }; // G, unknown — сигнал warn, назван
  'forge.threads': { timeoutMs: 30_000; onUnknown: 'retry-until' }; // P чтение один раз
  'forge.ci': { timeoutMs: 30_000; onUnknown: 'run' }; // P, только когда человек просил ждать CI
  'tests.coverage-map': { timeoutMs: 5_000; onUnknown: 'run' }; // G, пробел назван предупреждением
};

export function factKind<T>(fact: Fact<T>): 'value' | 'absent' | 'unknown' {
  if ('value' in fact) return 'value';
  if ('absent' in fact) return 'absent';
  return 'unknown';
}
