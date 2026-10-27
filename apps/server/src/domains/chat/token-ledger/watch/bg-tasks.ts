/**
 * Фоновые задачи вызова (R16, «фон долго»): какой id получил вызов, ушедший в фон, и
 * какая задача кончилась. Общий разбор живого потока (`ChatRunner.translate`) и хвоста
 * транскрипта (`transcript-events.ts`): у потока и у транскрипта поля одни — итог
 * вызова (`tool_use_result` / `toolUseResult`) и строка `user` с `<task-notification>`.
 */

type Json = Record<string, unknown>;

const obj = (value: unknown): Json | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : undefined;
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * Id фоновой задачи из итога вызова: `backgroundTaskId` у Bash в фоне, `agentId` у
 * субагента, запущенного в фон (статус `async_launched` или флаг `isAsync`). Обычный
 * субагент тоже несёт `agentId`, но кончается своим ответом — не фон.
 */
export function bgTaskIdOf(summary: unknown): string | undefined {
  const result = obj(summary);
  if (!result) return undefined;
  const bash = text(result.backgroundTaskId);
  if (bash) return bash;
  const status = typeof result.status === 'string' ? result.status : '';
  const async = result.isAsync === true || /async/i.test(status);
  return async ? text(result.agentId) : undefined;
}

export interface BgNotice {
  taskId: string;
  status?: string;
}

const NOTICE = /<task-notification>/;
const TASK_ID = /<task-id>\s*([^<\s]+)\s*</;
const STATUS = /<status>\s*([^<]+?)\s*</;

/** Текст строки `user` (строка или текстовые блоки) — уведомления о конце фоновых задач в нём. */
export function bgNoticesOf(content: unknown): BgNotice[] {
  const parts: string[] = [];
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) {
    for (const block of content) {
      const value = obj(block)?.text;
      if (typeof value === 'string') parts.push(value);
    }
  }
  const out: BgNotice[] = [];
  for (const part of parts) {
    if (!NOTICE.test(part)) continue;
    // В одной строке бывает несколько уведомлений: каждое — своим блоком.
    for (const chunk of part.split('<task-notification>').slice(1)) {
      const taskId = TASK_ID.exec(chunk)?.[1];
      if (!taskId) continue;
      const status = STATUS.exec(chunk)?.[1];
      out.push({ taskId, ...(status ? { status } : {}) });
    }
  }
  return out;
}

/** Остановка фоновой задачи вызовом (`TaskStop`, `KillShell`/`KillBash`): уведомления о ней нет. */
export function stoppedTaskOf(name: string, input: Record<string, unknown>): string | undefined {
  if (!/^(?:TaskStop|KillShell|KillBash)$/.test(name)) return undefined;
  return text(input.task_id) ?? text(input.shell_id) ?? text(input.bash_id);
}
