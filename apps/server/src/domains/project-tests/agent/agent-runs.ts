import { coreHomeOf } from '../../../lib/hop-recorder.mjs';
import { createCoreCaller } from '../../core-ask/core-ask.ts';
import { createCoreChatPort } from '../../chat/core-run/core-chat-port.ts';
import type { CoreChatPort } from '../../chat/core-run/core-run.types.ts';
import { testsCoreAdapterOf, type TestsCoreAdapter } from './core-run.ts';

/**
 * Кем идёт агент тестов: переходник ядра (`set-cli`) и имя CLI для текстов отказов. Бинарь CLI
 * находит ядро само (`cliPaths`, PATH ядра) — панель путь больше не ищет.
 */
export interface TestsAgentProvider {
  id: TestsCoreAdapter;
  name: string;
}

/** Провайдеры, у которых агент тестов идёт через ядро (переходник с хуком ядра). */
export function testsAgentDialectOf(providerId: string): TestsCoreAdapter | undefined {
  return testsCoreAdapterOf(providerId);
}

/** Порт ядра по умолчанию: запись ядра в его доме, проверка слушателя, число загрузки. */
export function defaultTestsCorePort(): CoreChatPort {
  return createCoreChatPort(createCoreCaller(() => coreHomeOf()));
}
