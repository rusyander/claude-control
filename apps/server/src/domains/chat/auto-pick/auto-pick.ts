import {
  AUTONOMOUS_PICK_MARKER,
  parseAutonomousPickMessage,
  type RecommendedPick,
} from '@agentdeck/contracts/chat-group-settings';
import type { ChatBlock } from '@agentdeck/contracts';
import { needsHuman, recommendedIndex } from '../group-questions/group-questions.ts';

/**
 * Автовыбор под автономией чата — как его узнаёт панель.
 *
 * Автономия чата снята 02.11.2026 (развилки групп решает ядро): хук набора
 * `autonomous-pick` в архиве, метку `AGENTDECK_AUTONOMOUS` панель снимает с
 * каждого прогона, и личный двойник хука в `~/.claude/hooks` молчит. Прежние
 * транскрипты хранят его ответы — текст `autonomousPickMessage` с меткой
 * `AUTONOMOUS_PICK_MARKER` в РЕЗУЛЬТАТЕ вызова `AskUserQuestion` (в потоке —
 * строка `user` с блоком `tool_result`, в транскрипте — та же строка), и лента
 * по-прежнему рисует их строкой автовыбора. Выбор, когда текст не разобрался,
 * считается по телу вызова — `recommendedPicks` ниже, как его считал хук.
 */

interface PickOption {
  label?: unknown;
  description?: unknown;
}

interface PickQuestion {
  question?: unknown;
  header?: unknown;
  options?: unknown;
}

const CRITICAL_HEADER = /^\s*\[?critical\]?\s*$/i;

/**
 * Что автономия выбирает сама на вызове `AskUserQuestion`: у КАЖДОГО вопроса —
 * вариант с рекомендацией (подпись или описание, ru/en, без отрицания — как у
 * группы «по плану», `recommendedIndex`). Нет рекомендации хоть у одного — `null`,
 * вызов целиком идёт человеку: первый вариант рекомендацией не считается.
 *
 * Рекомендованный вариант, который зовёт человека или утверждает сделанное им
 * («Я войду», «Session refreshed — continue», `needsHuman`), — тоже `null`: взять
 * его значит соврать агенту от имени человека. Прежний выбор (только
 * «(Recommended)» в подписи) такие варианты брал, а «(рекомендую)» и
 * рекомендацию в описании не узнавал и звал человека зря.
 */
export function recommendedPicks(input: unknown): RecommendedPick[] | null {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const picks: RecommendedPick[] = [];
  for (const raw of questions as (PickQuestion | null)[]) {
    if (typeof raw?.question !== 'string') return null;
    const options = (Array.isArray(raw.options) ? raw.options : []).filter(
      (option): option is PickOption =>
        Boolean(option) && typeof (option as PickOption).label === 'string',
    );
    const chosen = options[recommendedIndex(options)];
    if (!chosen || needsHuman(chosen)) return null;
    picks.push({
      question: raw.question,
      label: String(chosen.label),
      critical: typeof raw.header === 'string' && CRITICAL_HEADER.test(raw.header),
    });
  }
  return picks;
}

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
 * Что выбрано. Выбор — тот, что записан в тексте отказа: прежний ответ группы
 * «по плану» брал не всегда рекомендованный вариант, и пересчёт по
 * `recommendedPicks` подменял бы его. Тело вызова известно — из него
 * только заголовок `critical`; не известно (вызов пришёл раньше, чем панель его
 * увидела) — критичность неизвестна, и такой выбор в главный чат не сообщается.
 * Текст не разобрался — выбор считается по телу, как его считают хук и брокер.
 */
export function picksFor(input: unknown, text: string): RecommendedPick[] {
  const parsed = parseAutonomousPickMessage(text) ?? [];
  if (parsed.length > 0) return withCritical(input, parsed);
  const fromInput = input === undefined ? null : recommendedPicks(input);
  return fromInput ?? [];
}

/**
 * Выбор события `autoPick` при известном теле вызова: подписи — из события
 * (разобранный текст отказа), критичность — из тела; событие без выбора
 * (текст не разобрался) — по телу.
 */
export function confirmedPicks(
  input: unknown,
  picks: readonly { question: string; label: string }[],
): RecommendedPick[] {
  if (picks.length > 0) return withCritical(input, picks);
  return recommendedPicks(input) ?? [];
}

/** Критичность выбора — по заголовку его вопроса в теле вызова. */
function withCritical(
  input: unknown,
  picks: readonly { question: string; label: string }[],
): RecommendedPick[] {
  const questions = (input as { questions?: unknown } | null | undefined)?.questions;
  const list = Array.isArray(questions)
    ? (questions as { question?: unknown; header?: unknown }[])
    : [];
  return picks.map(({ question, label }) => {
    const header = list.find((item) => item?.question === question)?.header;
    return {
      question,
      label,
      critical: typeof header === 'string' && CRITICAL_HEADER.test(header),
    };
  });
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
