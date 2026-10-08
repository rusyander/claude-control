import type { AgentRun, QueuedMessage } from './agent-runs.types';

/**
 * Что показать пузырями ожидания: переданное агенту на ходу — первым (оно уже у
 * агента), за ним ещё передающееся (запрос в пути, Ф12), за ними очередь,
 * которая уйдёт только по концу хода. Событие `steer` может прийти раньше
 * ответа на запрос — тогда слово уже среди переданных, и второго пузыря нет.
 */
export function pendingBubbles(
  run: Pick<AgentRun, 'steered' | 'queued' | 'steering'>,
): QueuedMessage[] {
  const steered = run.steered ?? [];
  const delivered = new Map<string, number>();
  for (const item of steered) delivered.set(item.text, (delivered.get(item.text) ?? 0) + 1);
  const sending = (run.steering ?? []).filter((item) => {
    const left = delivered.get(item.text) ?? 0;
    if (left === 0) return true;
    delivered.set(item.text, left - 1);
    return false;
  });
  return [
    ...steered.map((item) => ({
      id: `steered-${item.at}`,
      prompt: item.text,
      steered: true,
    })),
    ...sending.map((item) => ({ id: item.id, prompt: item.text, sending: true })),
    ...run.queued,
  ];
}
