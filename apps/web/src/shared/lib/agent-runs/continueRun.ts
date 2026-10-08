import { autoRetries } from './agent-runs.retry';
import { startRun } from './agent-runs.lifecycle';
import { getRun } from './getRun';

/**
 * Продолжить упавший/остановленный разговор: просим агента продолжить с того
 * места, где он замолчал, не переспрашивая исходную задачу. Сессию не теряем.
 */
export function continueRun(id: string, prompt: string): void {
  const run = getRun(id);
  autoRetries.delete(run.id || id);
  void startRun({
    chatId: run.id || id,
    prompt,
    sessionId: run.sessionId,
    projectPath: run.projectPath,
    allowEdits: run.allowEdits,
    autoApprove: run.autoApprove,
    model: run.model,
    effort: run.effort,
  });
}
