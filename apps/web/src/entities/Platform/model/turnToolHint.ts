import type { ChatMessage, PlatformToolRoute } from '@agentdeck/contracts';
import { looksLikeToolCall } from '@agentdeck/contracts/platform-tool-hint';

/**
 * Подсказка под последним ходом агента через контур (развилки 3 и 5).
 *
 * `call-as-text` — ответ целиком вызов инструмента, написанный текстом, а
 * прослойка выключена: вызов не исполнен и не будет, лечится её включением.
 * `no-tools` — за ход ни одного вызова: модель могла не справиться с
 * инструментами. Первое сильнее: причина у него известна точно.
 *
 * Молчит, пока ход идёт (вызовы ещё впереди), и вне контура: там за инструменты
 * отвечает вендор, и подсказка про размер модели контура была бы чужой.
 */
export type TurnToolHint = 'call-as-text' | 'no-tools';

export interface TurnToolFacts {
  routed: boolean;
  running: boolean;
  toolRoute?: PlatformToolRoute;
  /** Вызовов за ход; `undefined` — посчитать нечем, и тогда о нуле молчим. */
  toolCalls: number | undefined;
  /** Текст ответа за ход. */
  text: string;
}

export function turnToolHint(facts: TurnToolFacts): TurnToolHint | undefined {
  if (!facts.routed || facts.running) return undefined;
  if (facts.toolRoute !== 'shim' && looksLikeToolCall(facts.text)) return 'call-as-text';
  return facts.toolCalls === 0 ? 'no-tools' : undefined;
}

/**
 * Последний ход разговора Claude: ответы модели после последней реплики
 * человека. Реплики с одними результатами инструментов в ленту не попадают
 * (`ChatRecords`), поэтому «последняя реплика человека» — действительно его.
 * Нет ответа после неё — хода нет.
 */
export function lastTurnFacts(
  messages: readonly Pick<ChatMessage, 'role' | 'blocks'>[],
): { toolCalls: number; text: string } | undefined {
  let start = messages.length;
  while (start > 0 && messages[start - 1]?.role === 'assistant') start -= 1;
  const turn = messages.slice(start);
  if (turn.length === 0) return undefined;
  let toolCalls = 0;
  const texts: string[] = [];
  for (const message of turn) {
    for (const block of message.blocks) {
      if (block.type === 'tool') toolCalls += 1;
      if (block.type === 'text') texts.push(block.text);
    }
  }
  // Вызов текстом — это ПОСЛЕДНИЙ текст хода: ранний абзац с примером не должен
  // превращать весь ход в «вызов, который не исполнили».
  return { toolCalls, text: texts.at(-1) ?? '' };
}
