import { aiderRunFacts } from '@agentdeck/providers/aider';
import type { CliAdapter } from '../adapter.types.ts';
import { createGatelessAdapter } from '../gateless.ts';

/**
 * Aider 0.86: хуков до вызова нет, списка запретов команд и путей нет (`--yes-always` и
 * подтверждения — это всё). Защиту ядра поставить некуда — запуск отказан (Q8).
 */
export function createAiderAdapter(): CliAdapter {
  return createGatelessAdapter(
    aiderRunFacts,
    'has no pre-tool hook and no deny list (aider 0.86); a core judge cannot be placed',
  );
}
