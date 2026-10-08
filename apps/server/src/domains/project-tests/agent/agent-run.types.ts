import type { spawn as nodeSpawn } from 'node:child_process';
import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import type { ChatEvent } from '../../chat/chat-events.ts';
import type { RunPermissionGate, RunScope } from '../run-permissions/run-permissions.ts';

/**
 * Прогон агента тестов у чужого CLI (Qwen Code, Codex). Реестр прогонов
 * (`runs.ts`) разбирает те же события, что у Claude (`consume`), поэтому
 * запуск отдаёт `ChatEvent` — плюс код текста у ошибки: отказ проверки прав
 * человек обязан прочитать на своём языке.
 */
export type TestsAgentEvent =
  | Exclude<ChatEvent, { kind: 'error' }>
  | {
      kind: 'error';
      message: string;
      messageCode?: ServerMessageCode;
      params?: ServerMessageParams;
    };

export interface TestsAgentStartOptions {
  /** Путь к CLI, найденный в PATH панели. */
  command: string;
  /** Имя CLI для человека («Qwen Code») — подстановка в тексты отказов. */
  providerName: string;
  prompt: string;
  /** Корень проекта — рабочий каталог агента. */
  cwd: string;
  /** Доступы стенда: только переменными процесса, ни в задании, ни в логе. */
  env: Record<string, string>;
  /** Приёмник прав прогона — без него чужой CLI не запускается вовсе. */
  gate: RunPermissionGate;
  /**
   * Границы прогона: по ним решает тот, кто отвечает CLI на месте (Codex
   * спрашивает панель сам, по своему протоколу, а не через приёмник).
   */
  scope: RunScope;
  /** Отказ, принятый на месте, — в лог прогона, как отказ приёмника. */
  onDeny?: (tool: string, message: string) => void;
  /** Подменяемый spawn — в тестах ничего настоящего не запускается. */
  spawnImpl?: typeof nodeSpawn;
}

export interface TestsAgentRun {
  /** PID процесса CLI — известен сразу после `start`, для журнала процессов. */
  readonly pid: number | undefined;
  /** Кончается вместе с прогоном; итог — событиями `done`/`error`. */
  start(options: TestsAgentStartOptions, onEvent: (event: TestsAgentEvent) => void): Promise<void>;
  stop(): void;
}
