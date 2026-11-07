import type { StepFn } from '@agentdeck/stub-model';
import type { StubTask } from '../stub-tasks.types.ts';
import { assistantTurns, findBuiltin, scriptFor } from '../script.ts';

/**
 * Сценарий заглушки для исполнителя под ведением (этап 11, W2-12b): первым ответом главного цикла
 * модель зовёт субагента (`Agent`, у старых сборок `Task`), дальше — ходы задачи, как `scriptFor`.
 * Ход субагента — нулевой ответ: ходы задачи сдвинуты на один, номер ответа считает и его.
 */

export const SUBAGENT_PROMPT = 'LEAD_WORKER_SUB answer DONE';
const SUBAGENT_TOOLS: readonly string[] = ['Agent', 'Task'];

export function leadWorkerScriptFor(task: Pick<StubTask, 'moves'>, closing = 'done'): StepFn {
  const rest = scriptFor({ moves: [{ op: 'text', text: closing }, ...task.moves] }, closing);
  return (ctx) => {
    const first = assistantTurns(ctx.dialect, ctx.request.body) === 0;
    // Субагент всё же пошёл (отказа не было): его разговор начинается с его вводной.
    if (first && ctx.request.raw.includes(SUBAGENT_PROMPT)) return { text: 'DONE' };
    const agent = ctx.info.tools.find((t) => SUBAGENT_TOOLS.includes(t.name));
    if (first && agent && findBuiltin(ctx.info.tools, 'shell'))
      return {
        tool: {
          name: agent.name,
          args: {
            description: 'lead worker probe',
            prompt: SUBAGENT_PROMPT,
            subagent_type: 'general-purpose',
          },
        },
      };
    return rest(ctx);
  };
}
