import type { JournalLine } from '@agentdeck/contracts/core/journal';
import type { AskView } from '@agentdeck/contracts/core/task-view';
import type { TaskFoldState } from '../journal/reduce/reduce.types.ts';

/**
 * Факты вопроса для карточки вне панели (этап 12, D29, P188): бот Telegram рисует тот же выбор,
 * что карточка панели, — ему нужны текст, варианты и цель отказа права. Свёртка их не хранит (номер
 * версии свёртки не растёт), поэтому вид читает строки журнала: `human.asked` по `askId`, решение
 * `permit`, на которое ссылается `cause` вопроса, и канал `human.answered`.
 */
export type AskFacts = Pick<AskView, 'question' | 'options' | 'permit' | 'answeredBy'>;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Факты каждого вопроса задачи по `askId`; вопроса без строки `human.asked` в карте нет. */
export function askFactsOf(
  state: TaskFoldState,
  lines: readonly JournalLine[],
): Map<string, AskFacts> {
  const bySeq = new Map<number, JournalLine>();
  for (const line of lines) bySeq.set(line.seq, line);
  const out = new Map<string, AskFacts>();
  for (const line of lines) {
    if (line.kind === 'human.asked') {
      const d = (line as JournalLine<'human.asked'>).data;
      const permit = permitOf(state, d.askId, line.cause, bySeq);
      out.set(d.askId, {
        ...out.get(d.askId),
        question: d.question,
        options: [...d.options],
        ...(permit ? { permit } : {}),
      });
    } else if (line.kind === 'human.answered') {
      const d = (line as JournalLine<'human.answered'>).data;
      out.set(d.askId, { ...out.get(d.askId), answeredBy: d.channel });
    }
  }
  return out;
}

/** Цель отказа права: проект — репозиторий единицы шага вопроса, путь и действие — из решения. */
function permitOf(
  state: TaskFoldState,
  askId: string,
  cause: number | undefined,
  bySeq: ReadonlyMap<number, JournalLine>,
): AskFacts['permit'] {
  if (cause === undefined) return undefined;
  const decision = bySeq.get(cause);
  if (decision?.kind !== 'decision') return undefined;
  const d = (decision as JournalLine<'decision'>).data;
  if (d.class !== 'permit' || !isObj(d.output)) return undefined;
  const target = d.output.target;
  const op = d.output.action;
  if (typeof target !== 'string' || !target || typeof op !== 'string' || !op) return undefined;
  const stepId = state.asks[askId]?.stepId;
  const unitId = stepId ? state.steps[stepId]?.unitId : undefined;
  const project = unitId ? state.units[unitId]?.repoKey : undefined;
  return project ? { project, target, op } : undefined;
}
