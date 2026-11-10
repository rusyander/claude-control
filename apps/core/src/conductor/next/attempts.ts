import type { Scenario, StepDef } from '@agentdeck/contracts/core/scenario';
import type { StepRecord, TaskFoldState } from '../../journal/reduce/reduce.types.ts';
import { END_REASON, type Attempt, type UnitView } from './next.types.ts';

/**
 * Вид единицы для `conductor/next`: попытки каждого шага сценария по свёртке журнала. Только
 * чтение — решения здесь нет, лишь факты, по которым судит `decideNext`.
 */

const TERMINAL_STEP = new Set(['done', 'failed', 'skipped']);

/** Порядок шагов: топологический по `after`, при равенстве — порядок сценария (стабильно). */
export function topoOrder(scenario: Scenario): StepDef[] {
  const done = new Set<string>();
  const out: StepDef[] = [];
  let moved = true;
  while (moved && out.length < scenario.steps.length) {
    moved = false;
    for (const def of scenario.steps) {
      if (done.has(def.id) || !def.after.every((a) => done.has(a))) continue;
      done.add(def.id);
      out.push(def);
      moved = true;
    }
  }
  return out;
}

export function unitView(state: TaskFoldState, unitId: string): UnitView {
  const byDef = new Map<string, Attempt[]>();
  let active: Attempt | null = null;
  for (const [stepId, rec] of Object.entries(state.steps)) {
    if (rec.unitId !== unitId) continue;
    const attempt: Attempt = { stepId, rec };
    const list = byDef.get(rec.stepDefId) ?? [];
    list.push(attempt);
    byDef.set(rec.stepDefId, list);
    if (!TERMINAL_STEP.has(rec.state) && (!active || rec.startedSeq > active.rec.startedSeq)) {
      active = attempt;
    }
  }
  for (const list of byDef.values()) list.sort((a, b) => a.rec.startedSeq - b.rec.startedSeq);
  return { unitId, byDef, active };
}

export function latest(view: UnitView, defId: string): Attempt | undefined {
  const list = view.byDef.get(defId);
  return list?.[list.length - 1];
}

/** Код причины конца шага: `step.ended.reason` начинается с него (`<code>: подробности`). */
export function endCode(rec: StepRecord): string {
  const reason = rec.reason ?? '';
  const colon = reason.indexOf(':');
  return colon < 0 ? reason : reason.slice(0, colon);
}

export function hasBlocking(rec: StepRecord): boolean {
  return (rec.claim?.call.findings ?? []).some((f) => f.severity === 'blocking');
}

/** Сколько раз шаг сценария кончился без исхода (G14: одна свежая попытка, потом точка 6). */
export function noOutcomeCount(view: UnitView, defId: string): number {
  return (view.byDef.get(defId) ?? []).filter(
    (a) => a.rec.state === 'failed' && endCode(a.rec) === END_REASON.noOutcome,
  ).length;
}

/**
 * Шаг сценария закрыт: последняя попытка `done`/`skipped` и не устарела. Устарела — если зависимость
 * перезапустилась позже неё, или (ревью) правка после неё закончилась `done`: ревью ⇄ правка (G14).
 */
export function satisfied(view: UnitView, scenario: Scenario, def: StepDef): boolean {
  const last = latest(view, def.id);
  if (!last || (last.rec.state !== 'done' && last.rec.state !== 'skipped')) return false;
  return staleBy(view, scenario, def, last) === null;
}

/** Что сделало попытку устаревшей: id шага сценария или null. */
export function staleBy(
  view: UnitView,
  scenario: Scenario,
  def: StepDef,
  last: Attempt,
): string | null {
  for (const dep of def.after) {
    // Ответ ревьюерам не устаревает от повторной публикации: она и несёт его ответы (G15),
    // иначе ответ ⇄ публикация крутились бы без конца.
    if (def.kind === 'answer-reviewers' && kindOf(scenario, dep) === 'publish') continue;
    const d = latest(view, dep);
    if (d && d.rec.state === 'done' && d.rec.startedSeq > last.rec.startedSeq) return dep;
  }
  if (def.kind === 'final-gate') {
    // Ответ ревьюерам мог принести правку кода: финальная проверка и публикация — заново, ДО
    // того как ответы уйдут (05 §After publish, G15): ответы шлёт только шаг публикации.
    for (const answer of scenario.steps) {
      if (answer.kind !== 'answer-reviewers') continue;
      const a = latest(view, answer.id);
      if (a && a.rec.state === 'done' && a.rec.startedSeq > last.rec.startedSeq) return answer.id;
    }
  }
  if (def.kind !== 'review') return null;
  for (const fix of scenario.steps) {
    if (fix.kind !== 'fix' || !fix.after.includes(def.id)) continue;
    const f = latest(view, fix.id);
    if (f && f.rec.state === 'done' && f.rec.startedSeq > last.rec.startedSeq) return fix.id;
  }
  return null;
}

/**
 * Ревью, за которым идёт правка: первое из `after` вида `review`. С видом единицы (этап 12, P185) —
 * и второе ревью (`crossOf` на это ревью): его блокирующая находка ведёт к правке, когда у первого
 * их нет; чистое второе ревью блокирующее первое не снимает — его вердикт ничего не одобряет.
 */
export function reviewOf(scenario: Scenario, fix: StepDef, view?: UnitView): StepDef | undefined {
  const primary = scenario.steps.find((s) => s.kind === 'review' && fix.after.includes(s.id));
  if (!view || !primary) return primary;
  const blocked = (d: StepDef): boolean => {
    const a = latest(view, d.id);
    return a !== undefined && hasBlocking(a.rec);
  };
  if (blocked(primary)) return primary;
  const cross = scenario.steps.find(
    (s) => s.kind === 'review' && s.crossOf === primary.id && blocked(s),
  );
  return cross ?? primary;
}

function kindOf(scenario: Scenario, id: string): string | undefined {
  return scenario.steps.find((s) => s.id === id)?.kind;
}

/**
 * Шаги, зависящие от публикации (сама она и всё после неё): единица идёт к ним через машину
 * «готово к публикации» → «опубликовано» → «отвечает» (`conductor/next/publish.ts`).
 */
export function afterPublish(scenario: Scenario): Set<string> {
  const out = new Set<string>();
  for (const def of topoOrder(scenario)) {
    if (def.kind === 'publish' || def.after.some((a) => out.has(a))) out.add(def.id);
  }
  return out;
}
