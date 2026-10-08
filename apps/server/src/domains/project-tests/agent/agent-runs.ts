import { ChatRun } from '../../chat/ChatRunner/ChatRunner.ts';
import type { TestsAgentRun } from './agent-run.types.ts';
import { CodexTestsRun } from './codex-run.ts';
import { QwenTestsRun } from './qwen-run.ts';

/**
 * Кем идёт агент тестов. Claude — без команды: `ChatRun` берёт CLI по
 * умолчанию, как и прежде. Чужой CLI — с путём, найденным маршрутом в PATH
 * панели, и именем для текстов отказов.
 */
export type TestsAgentProvider =
  { id: 'claude' } | { id: 'qwen' | 'codex'; name: string; command: string };

/** Провайдеры, у которых есть запуск с проверкой каждой записи агента. */
export function testsAgentDialectOf(providerId: string): TestsAgentProvider['id'] | undefined {
  return providerId === 'claude' || providerId === 'qwen' || providerId === 'codex'
    ? providerId
    : undefined;
}

/** Прогон под провайдера. Claude — прежний `ChatRun`, нетронутый. */
export function makeAgentRun(provider: TestsAgentProvider): ChatRun | TestsAgentRun {
  if (provider.id === 'qwen') return new QwenTestsRun();
  if (provider.id === 'codex') return new CodexTestsRun();
  return new ChatRun();
}
