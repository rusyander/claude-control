import type { ServerMessageCode, ServerMessageParams } from '@agentdeck/contracts/server-messages';
import type { ChatEvent } from '../../chat/chat-events.ts';

/**
 * События прогона агента тестов (задача ядра, `core-run.ts`) в словаре ленты чата — реестр
 * прогонов (`runs.ts`) разбирает их в лог и расход (`consume`), — плюс код текста у ошибки:
 * отказ ядра человек обязан прочитать на своём языке.
 */
export type TestsAgentEvent =
  | Exclude<ChatEvent, { kind: 'error' }>
  | {
      kind: 'error';
      message: string;
      messageCode?: ServerMessageCode;
      params?: ServerMessageParams;
    };
