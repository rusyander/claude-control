/** Готовые события: по одному на каждый распространённый случай. */
export interface EventFixture {
  id: string;
  event: string;
  title: string;
  description: string;
  /** Ожидание автора заготовки: должен ли хук остановить действие. */
  expectsBlock: boolean;
  payload: Record<string, unknown>;
}

/**
 * Как хук отнёсся к событию.
 *
 * Способов сообщить решение два, и оба в ходу: старый — выйти с кодом 2,
 * новый — вернуть JSON с полем permissionDecision. Стенд обязан понимать оба,
 * иначе хук, который честно требует подтверждения, выглядел бы бездействующим.
 *
 * `error` — не решение хука, а его отсутствие: процесс не запустился (нет
 * интерпретатора, нет каталога) или завершился ошибкой. Отдельное значение
 * нужно потому, что раньше такой исход показывался как «пропустил» — то есть
 * ровно как хук, который отработал и сознательно не вмешался. Человек делал
 * вывод «страж не реагирует на rm -rf», хотя страж вообще не запускался.
 */
export type HookDecision = 'block' | 'ask' | 'pass' | 'error';

export interface ProbeResult {
  fixtureId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  decision: HookDecision;
  /** Пояснение хука: почему он вмешался. */
  reason?: string;
  /** Текст, который хук добавляет в контекст (подсказки и брифинги). */
  addedContext?: string;
  /** Вмешался ли хук так, как задумано заготовкой. */
  matchesExpectation: boolean;
  durationMs: number;
  parsed?: unknown;
  timedOut: boolean;
}
