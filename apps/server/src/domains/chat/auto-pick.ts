import {
  AUTONOMOUS_PICK_MARKER,
  parseAutonomousPickMessage,
  pickRecommended,
  type RecommendedPick,
} from '@agentdeck/contracts/chat-group-settings';
import type { ChatBlock } from '@agentdeck/contracts';

/**
 * Автовыбор под автономией чата — как его узнаёт панель.
 *
 * Вопрос `AskUserQuestion` закрывают ДВА места, и оба пишут в результат вызова
 * один и тот же текст `autonomousPickMessage` с меткой
 * `AUTONOMOUS_PICK_MARKER`: глобальный хук `PreToolUse` (он срабатывает раньше
 * брокера) и брокер прав панели (там, где хука нет). Поэтому признак берётся не
 * из брокера, а из РЕЗУЛЬТАТА вызова — он один на оба пути: в потоке прогона
 * это строка `user` с блоком `tool_result`, в транскрипте — та же строка. Один
 * результат на один вызов — и повтор между путями невозможен по устройству.
 */

/** Блок `tool_result` — столько, сколько панель из него читает. */
interface ResultBlockLike {
  type?: string;
  tool_use_id?: string;
  content?: unknown;
}

/** Текст результата инструмента: строкой или списком текстовых блоков. */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('\n');
}

/** Результаты вызовов, закрытых автовыбором: id вызова и текст отказа. */
export function autoPickResults(content: unknown): { toolUseId: string; text: string }[] {
  if (!Array.isArray(content)) return [];
  const found: { toolUseId: string; text: string }[] = [];
  for (const raw of content as ResultBlockLike[]) {
    if (raw?.type !== 'tool_result' || !raw.tool_use_id) continue;
    const text = toolResultText(raw.content);
    if (text.includes(AUTONOMOUS_PICK_MARKER)) found.push({ toolUseId: raw.tool_use_id, text });
  }
  return found;
}

/**
 * Что выбрано. Тело вызова известно — считаем тем же `pickRecommended`, что
 * хук и брокер: только оно знает заголовок `critical`. Не известно (вызов
 * пришёл раньше, чем панель его увидела) — разбираем текст отказа, и
 * критичность тогда неизвестна: такой выбор в главный чат не сообщается.
 */
export function picksFor(input: unknown, text: string): RecommendedPick[] {
  const fromInput = input === undefined ? null : pickRecommended(input);
  if (fromInput) return fromInput;
  return (parseAutonomousPickMessage(text) ?? []).map((pick) => ({
    question: pick.question,
    label: pick.label,
    critical: false,
  }));
}

// --- Лента из транскрипта: выбор ложится на блок вопроса ---

export interface AskSeen {
  input: unknown;
  block: Extract<ChatBlock, { type: 'tool' }>;
}

/**
 * Блоки вызовов у `toBlocks` идут в том же порядке, что `tool_use` в записи, —
 * по этому порядку блок ленты и находит свой id.
 */
export function rememberAsks(
  asks: Map<string, AskSeen>,
  content: unknown,
  blocks: ChatBlock[],
): void {
  if (!Array.isArray(content)) return;
  const tools = blocks.filter(
    (block): block is Extract<ChatBlock, { type: 'tool' }> => block.type === 'tool',
  );
  let index = 0;
  for (const raw of content as { type?: string; name?: string; id?: string; input?: unknown }[]) {
    if (raw?.type !== 'tool_use') continue;
    const block = tools[index];
    index += 1;
    if (raw.name === 'AskUserQuestion' && raw.id && block) {
      asks.set(raw.id, { input: raw.input, block });
    }
  }
}

export function attachAutoPicks(asks: Map<string, AskSeen>, content: unknown): void {
  for (const result of autoPickResults(content)) {
    const seen = asks.get(result.toolUseId);
    if (!seen) continue;
    // Блок общий с репликой в окне ленты: правка видна там, где он уже лежит.
    seen.block.autoPicks = picksFor(seen.input, result.text).map(({ question, label }) => ({
      question,
      label,
    }));
    asks.delete(result.toolUseId);
  }
}
