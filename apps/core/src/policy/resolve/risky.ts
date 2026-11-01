import type { Scenario } from '@agentdeck/contracts/core/scenario';

/**
 * Рискованное живое решение человека (06:8-9, G12): ревьюер ниже автора, пропуск класса проверки.
 * Уровень 2 вправе расширять — поэтому здесь не отказ, а ОДНО предупреждение на команду: оно
 * ложится в `command.applied.outcome.warnings`, повтор того же `cmdId` возвращает записанный исход
 * (второго предупреждения нет), затем решение исполняется. Чистая функция: ранги моделей даёт
 * тот, кто их знает (переходник через порт), сама она моделей не знает (P108).
 */

/** Ранг модели переходника; `null` — модель неизвестна (или умолчание CLI без имени). */
export type ModelRank = (adapter: string, model: string | null) => number | null;

/** Модель шага, как её выбрал бы судья `tier`: переходник и имя (`null` — умолчание CLI). */
export interface StepModel {
  stepId: string;
  adapter: string | null;
  model: string | null;
}

/** Пара «ревью ← автор» до и после команды. */
export interface ReviewPair {
  before: { review: StepModel; author: StepModel };
  after: { review: StepModel; author: StepModel };
}

export type RiskyInput =
  | { kind: 'set-model'; pairs: readonly ReviewPair[]; rank: ModelRank | undefined }
  | { kind: 'edit-scenario'; before: Scenario; after: Scenario };

const label = (m: StepModel): string => `${m.adapter ?? '?'}/${m.model ?? 'cli-default'}`;
const same = (a: StepModel, b: StepModel): boolean =>
  a.adapter === b.adapter && a.model === b.model;

function rankOf(rank: ModelRank | undefined, m: StepModel): number | null {
  if (!rank || m.adapter === null) return null;
  return rank(m.adapter, m.model);
}

/** set-model: ревьюер, чья модель после команды ниже модели автора, — риск (06:8). */
function reviewerBelowAuthor(pairs: readonly ReviewPair[], rank: ModelRank | undefined): string[] {
  const out: string[] = [];
  for (const { before, after } of pairs) {
    // Команда пары не тронула — не её риск: предупреждение одно и про ЭТУ команду.
    if (same(before.review, after.review) && same(before.author, after.author)) continue;
    const r = rankOf(rank, after.review);
    const a = rankOf(rank, after.author);
    const pair = `review step ${after.review.stepId} (${label(after.review)}) vs its author step ${after.author.stepId} (${label(after.author)})`;
    if (r === null || a === null) {
      out.push(`${pair}: model rank unknown, cannot confirm the reviewer is not below the author`);
    } else if (r < a) {
      out.push(`${pair}: the reviewer model ranks below the author model`);
    }
  }
  return out;
}

/** edit-scenario: пропущенная проверка, шаг проверки или вопроса, поднятый предел кругов. */
function droppedChecks(before: Scenario, after: Scenario): string[] {
  const out: string[] = [];
  const next = new Map(after.steps.map((s) => [s.id, s]));
  for (const old of before.steps) {
    const now = next.get(old.id);
    if (!now) {
      if (old.kind === 'check' || old.kind === 'ask-human')
        out.push(`drops ${old.kind} step ${old.id}`);
      continue;
    }
    for (const check of old.checks.required)
      if (!now.checks.required.includes(check))
        out.push(`step ${old.id} drops required check ${check}`);
    if (now.roundCap > old.roundCap)
      out.push(`step ${old.id} raises roundCap ${old.roundCap} → ${now.roundCap}`);
  }
  return out;
}

export function riskyOf(input: RiskyInput): string[] {
  return input.kind === 'set-model'
    ? reviewerBelowAuthor(input.pairs, input.rank)
    : droppedChecks(input.before, input.after);
}
