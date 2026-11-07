import { sdkTaskLine, type TaskLine, type TaskRule } from '../sdk-stream/task-lines.ts';

/**
 * Строки задач Claude Code (запись 2.1.310, `s8-probe.jsonl`, проба монитора I1): `system`
 * `task_started` / `task_updated{patch}` / `task_notification`, поля — на верхнем уровне строки.
 * `local_agent` — субагент, `local_bash` — оболочка (и монитор: его отличает только имя вызова
 * `Monitor`), остальные типы — `other` с именем. Файл вывода фоновой оболочки — в тексте её
 * результата («Output is being written to: <путь>.»), код выхода — в итоге уведомления.
 */

const KINDS: Readonly<Record<string, TaskLine['kind']>> = {
  local_agent: 'agent',
  local_bash: 'shell',
};

const OUTPUT_FILE = /Output is being written to: (.+?)\.(?:\s|$)/;
const EXIT_CODE = /\(exit code (-?\d+)\)/;

export const CLAUDE_TASKS: TaskRule = {
  read(line) {
    if (line.type !== 'system') return null;
    return sdkTaskLine(line.subtype, line, (f) => {
      const type = typeof f.task_type === 'string' && f.task_type !== '' ? f.task_type : null;
      return { kind: type ? (KINDS[type] ?? 'other') : null, typeName: type };
    });
  },
  launched(text) {
    const file = OUTPUT_FILE.exec(text)?.[1];
    return file ? { outputFile: file } : {};
  },
  exitCode(summary) {
    const code = EXIT_CODE.exec(summary)?.[1];
    return code === undefined ? undefined : Number(code);
  },
};
