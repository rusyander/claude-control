import { sdkTaskLine, type TaskRule } from '../sdk-stream/task-lines.ts';

/**
 * Строки задач Qwen Code (запись 0.24.3, `s8-probe.jsonl`): `system` `task_started` /
 * `task_notification`, поля — в `data`, флага фона нет. Агент запускается в фон и без
 * `run_in_background` («Background agent launched successfully»). Фоновая оболочка строк задач
 * не даёт вовсе: её знак — `is_background: true` во входе `run_shell_command`, имя и pid — в
 * тексте результата («Background shell bg_… started (pid N).»); её конца поток не называет.
 */

// Только в начале текста, где CLI пишет строку запуска: pid идёт в уборку за владельцем (снос
// процесса), и чужая строка дальше в тексте не должна навести её на чужой процесс.
const LAUNCHED = /^Background shell (\S+) started \(pid (\d+)\)/;

export const QWEN_TASKS: TaskRule = {
  read(line) {
    if (line.type !== 'system') return null;
    const data =
      typeof line.data === 'object' && line.data !== null && !Array.isArray(line.data)
        ? (line.data as Record<string, unknown>)
        : {};
    return sdkTaskLine(line.subtype, data, (f) =>
      typeof f.subagent_type === 'string' && f.subagent_type !== ''
        ? { kind: 'agent', typeName: null }
        : { kind: 'other', typeName: null },
    );
  },
  backgroundCall(name, input) {
    return name === 'run_shell_command' && input.is_background === true ? 'background-shell' : null;
  },
  launched(text) {
    const m = LAUNCHED.exec(text);
    if (!m) return {};
    const pid = Number(m[2]);
    return { itemId: m[1]!, ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
  },
  agentsBackgroundByDefault: true,
};
