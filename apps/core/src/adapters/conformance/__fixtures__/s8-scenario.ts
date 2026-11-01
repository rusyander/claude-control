import type { ToolCall } from '@agentdeck/stub-model';

/**
 * Сценарий пробы этапа 8 — один на запись (`record-s8.ts`) и проигрыш (`s8-probe.test.ts`):
 * метка в сообщении человека → вызовы инструментов, которые заглушка модели отдаёт по одному.
 * Имена и поля инструментов — у каждого CLI свои (факт CLI, 2.1.310 / 0.24.3).
 */

export type S8Cli = 'claude' | 'qwen';

export interface S8Turn {
  message: string;
  /** Ждать хода, начатого CLI самим (пробуждение фоновой задачей), мс. */
  waitWakeMs?: number;
}

export function s8Turns(): S8Turn[] {
  return [
    { message: 'PROBE_FAIL run the failing command' },
    { message: 'PROBE_SLEEP wait a bit' },
    { message: 'PROBE_READ read the file twice' },
    { message: 'PROBE_BG start the background job', waitWakeMs: 20_000 },
    { message: 'PROBE_TASK ask a subagent' },
    { message: 'PROBE_AFTER after compaction' },
  ];
}

/**
 * Сжатие разговора: слэш-команда ядра до CLI командой не доходит (переходник ставит метку
 * платформы первой строкой), поэтому ответ хода с подагентом заявляет почти полное окно — CLI
 * сжимает разговор сам перед следующим ходом. Qwen при 190k на модели без известного окна
 * отказывает ходу («Context is too large»), а не сжимает — ему заявлено меньше.
 */
export function s8FullWindow(cli: S8Cli, marker: string): { input: number; output: number } | null {
  if (marker !== 'PROBE_TASK') return null;
  return { input: cli === 'claude' ? 190_000 : 100_000, output: 10 };
}

export function s8Plan(cli: S8Cli, at: { big: string; cwd: string }): Record<string, ToolCall[]> {
  if (cli === 'claude') {
    return {
      PROBE_FAIL: [
        {
          name: 'Bash',
          args: { command: 'echo boom-to-stderr 1>&2; exit 3', description: 'fail on purpose' },
        },
      ],
      PROBE_SLEEP: [
        { name: 'Bash', args: { command: 'sleep 25', description: 'wait' } },
        { name: 'Bash', args: { command: 'sleep 21 && echo after', description: 'wait chained' } },
      ],
      PROBE_READ: [
        { name: 'Read', args: { file_path: at.big, offset: 10, limit: 5 } },
        { name: 'Read', args: { file_path: at.big } },
      ],
      PROBE_BG: [
        {
          name: 'Bash',
          args: {
            command: 'node -e "setTimeout(()=>console.log(String.fromCharCode(66,71)),3000)"',
            description: 'background job',
            run_in_background: true,
          },
        },
      ],
      PROBE_TASK: [
        {
          // Имя, которое 2.1.310 объявляет модели (`Task` в init — старое имя, CLI принимает оба).
          name: 'Agent',
          args: {
            description: 'probe subagent',
            prompt: `PROBE_SUB read ${at.big}`,
            subagent_type: 'general-purpose',
          },
        },
      ],
      PROBE_SUB: [{ name: 'Read', args: { file_path: at.big, offset: 1, limit: 2 } }],
      PROBE_AFTER: [{ name: 'Read', args: { file_path: at.big, offset: 1, limit: 1 } }],
    };
  }
  return {
    PROBE_FAIL: [
      {
        name: 'run_shell_command',
        args: { command: 'echo boom-to-stderr 1>&2 & exit 3', description: 'fail on purpose' },
      },
    ],
    PROBE_SLEEP: [
      { name: 'run_shell_command', args: { command: 'sleep 25', description: 'wait' } },
      {
        name: 'run_shell_command',
        args: { command: 'timeout /t 21 /nobreak && echo after', description: 'wait chained' },
      },
    ],
    PROBE_READ: [
      { name: 'read_file', args: { file_path: at.big, offset: 10, limit: 5 } },
      { name: 'read_file', args: { file_path: at.big } },
    ],
    PROBE_BG: [
      {
        name: 'run_shell_command',
        args: {
          command: 'node -e "setTimeout(()=>console.log(String.fromCharCode(66,71)),3000)"',
          description: 'background job',
          is_background: true,
        },
      },
    ],
    PROBE_TASK: [
      {
        name: 'agent',
        args: {
          description: 'probe subagent',
          prompt: `PROBE_SUB read ${at.big}`,
          subagent_type: 'general-purpose',
        },
      },
    ],
    PROBE_SUB: [{ name: 'read_file', args: { file_path: at.big, offset: 1, limit: 2 } }],
    PROBE_AFTER: [{ name: 'read_file', args: { file_path: at.big, offset: 1, limit: 1 } }],
  };
}
