import type { CheckRecord, QuarantineEntry, RedClass } from '@agentdeck/contracts/core/records';

/** Вход классификации красного (04:78-81, R:S2-13, P75). */
export interface RedInput {
  /** Не-зелёная запись единицы на финальном дереве (fail, pass-flaky или no-verdict). */
  final: CheckRecord;
  /** Запись той же проверки и единицы на базе (grade `base`); null — базу не гоняли. */
  base: CheckRecord | null;
  /** Замыкание единицы задето изменением задачи (A `closureOf` × changed). */
  inChangedClosure: boolean;
  changed: string[];
  /** Тесты в карантине этой проверки: полный путь и файл, если известен (тот же путь в другом файле — другой тест). */
  quarantined: Pick<QuarantineEntry, 'test' | 'file'>[];
  /** Проверку называет обязательной сценарий: её базовый красный — всё равно дефект (04:80). */
  scenarioRequired: boolean;
}

/**
 * `class` — класс решён; `need-base` — без прогона базы класс не решить (сомнение → прогон, а не
 * «устарел»); `rerun` — запись без вердикта (aborted): красным не считается, единицу гонят снова.
 */
export type RedOutcome =
  | { kind: 'class'; red: RedClass; why: string }
  | { kind: 'need-base'; why: string }
  | { kind: 'rerun'; why: string };
