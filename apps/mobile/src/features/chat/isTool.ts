import type { ChatBlock } from '@agentdeck/contracts';

export function isTool(block: ChatBlock): boolean {
  return block.type === 'tool';
}
