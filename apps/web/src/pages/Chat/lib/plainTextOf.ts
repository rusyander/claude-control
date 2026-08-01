import type { ChatMessage } from '@claude-control/contracts';

/** Текст реплики без разметки блоков — по нему сверяем своё сообщение с историей. */
export function plainTextOf(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block.type === 'text' ? block.text.trim() : ''))
    .join('\n')
    .trim();
}
