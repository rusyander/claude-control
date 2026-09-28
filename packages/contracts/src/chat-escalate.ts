/**
 * Блок критического замечания ребёнка — разбор без zod, для сервера, ленты
 * панели и телефона разом.
 *
 * Отдельным модулем от `chat-group-settings.ts` по одной причине: тот тянет
 * zod, а телефон собирает контракты-значения без него (`metro.config.js`
 * VALUE_MODULES). Прятать блок из текста обязаны все места ленты — Claude
 * (`MessageBubble`, `StreamedAnswer`), чужого CLI (`ProviderChatMessages`) и
 * телефона (`agentTextView`), иначе человек видит сырой JSON там, где панель
 * уже показала карточку.
 *
 * Формат — огороженный блок с языком `agentdeck:escalate` и JSON внутри:
 *
 * ```agentdeck:escalate
 * {"severity":"critical","text":"что случилось и почему это важно"}
 * ```
 *
 * Форма тела совпадает с `escalationSchema` (`chat-group-settings.ts`); тест
 * контрактов держит оба разбора согласными.
 */

import { blockLang, blockLangPattern } from './brand.ts';

/** Язык блока — тот же, что `ESCALATE_BLOCK_LANG`. */
export const ESCALATE_LANG = blockLang('escalate');

/** Потолок текста замечания — как у `escalationSchema`. */
export const ESCALATE_TEXT_MAX = 2_000;

export interface EscalateBlock {
  severity: 'critical';
  text: string;
}

export interface EscalateScan {
  /** Текст без разобранных блоков. */
  text: string;
  blocks: EscalateBlock[];
  /** Закрытые блоки, тело которых не разобрано, — остаются в тексте как есть. */
  rejected: number;
}

const OPEN = new RegExp(`(^|\\n)[ \\t]*\`\`\`[ \\t]*${blockLangPattern('escalate')}[ \\t]*\\r?\\n`);
const CLOSE = /(^|\n)[ \t]*```[ \t]*(\r?\n|$)/;

/** Тело блока → замечание; не то — `undefined`, и блок остаётся в тексте. */
export function parseEscalateBody(body: string): EscalateBlock | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { severity, text } = value as { severity?: unknown; text?: unknown };
  if (severity !== 'critical' || typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > ESCALATE_TEXT_MAX) return undefined;
  return { severity, text: trimmed };
}

/**
 * Вынуть блоки замечаний из текста ответа. Те же три случая, что у блока
 * продолжения (`scanHandoffBlocks`): закрытый и разобранный уходит из текста,
 * закрытый и сломанный остаётся как есть (прятать непонятое — терять слова
 * агента), незакрытый при `streaming` прячется до конца текста — иначе JSON
 * секундами стоит в ленте, пока агент дописывает блок. На законченном ответе
 * незакрытый блок остаётся текстом: съесть слова агента хуже, чем не показать
 * карточку.
 */
export function scanEscalateBlocks(
  source: string,
  options: { streaming?: boolean } = {},
): EscalateScan {
  const blocks: EscalateBlock[] = [];
  let rejected = 0;
  let rest = source;
  let out = '';

  for (;;) {
    const open = OPEN.exec(rest);
    if (!open) {
      out += rest;
      break;
    }
    const lead = (open[1] ?? '').length;
    const bodyStart = open.index + open[0].length;
    out += rest.slice(0, open.index + lead);

    const close = CLOSE.exec(rest.slice(bodyStart));
    if (!close) {
      if (!options.streaming) out += rest.slice(open.index + lead);
      break;
    }
    const body = rest.slice(bodyStart, bodyStart + close.index);
    const block = parseEscalateBody(body);
    if (block) {
      blocks.push(block);
    } else {
      rejected += 1;
      out += rest.slice(open.index + lead, bodyStart + close.index + close[0].length);
    }
    rest = rest.slice(bodyStart + close.index + close[0].length);
  }

  // Текст без блоков не трогается вовсе: обрезать края чужого текста не за что.
  if (blocks.length === 0 && out === source) return { text: source, blocks, rejected };
  return { text: out.replace(/\n{3,}/g, '\n\n').trim(), blocks, rejected };
}

/** Текст для показа человеку: без блоков замечаний. */
export function withoutEscalateBlocks(text: string, options?: { streaming?: boolean }): string {
  return scanEscalateBlocks(text, options).text;
}
