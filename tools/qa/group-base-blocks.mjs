/**
 * Первый запрос звена группы по блокам (B.1 плана экономии): сколько знаков
 * занимает каждая часть тела запроса, ушедшего наверх, — системный промпт по
 * блокам, инструменты (свои CLI и MCP), каждый кусок сообщений. Резать базу
 * можно только по этому замеру: на глаз «большое» и «нужное» путаются.
 *
 * Запись — в `<dir>/group-base-<stage>.json`; каталог задаёт вызывающий
 * (`check-run-layers.mjs --group-base`), по умолчанию `.agent/tmp` — вне git.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HEAD = 100;

const size = (value) => JSON.stringify(value ?? '').length;

/** Начало текста одной строкой: по нему блок узнаётся в отчёте. */
function headOf(text) {
  return text.replace(/\s+/g, ' ').trim().slice(0, HEAD);
}

/**
 * Куски сообщения. Вставки CLI идут текстом `<system-reminder>` — их голова
 * без тега, чтобы в отчёте было видно, ЧТО вставлено (перечень навыков,
 * CLAUDE.md, контекст хука), а не сам тег.
 */
function partsOf(message) {
  const content = Array.isArray(message.content)
    ? message.content
    : [{ type: 'text', text: String(message.content ?? '') }];
  return content.map((part) => {
    const text = typeof part.text === 'string' ? part.text : JSON.stringify(part);
    const reminder = /^\s*<system-reminder>\s*/.exec(text);
    return {
      role: message.role,
      kind: reminder ? 'reminder' : part.type,
      chars: text.length,
      head: headOf(reminder ? text.slice(reminder[0].length) : text),
    };
  });
}

/** Тело запроса Anthropic Messages → блоки с размерами. */
export function blocksOf(body) {
  const system = (Array.isArray(body.system) ? body.system : [{ text: String(body.system ?? '') }])
    .map((block) => block.text ?? '')
    .map((text) => ({ chars: text.length, head: headOf(text) }));
  const tools = (body.tools ?? []).map((tool) => ({
    name: tool.name,
    chars: size(tool),
    head: headOf(String(tool.description ?? '')),
  }));
  const sum = (list) => list.reduce((total, item) => total + item.chars, 0);
  const mcp = tools.filter((tool) => String(tool.name).startsWith('mcp__'));
  const builtin = tools.filter((tool) => !String(tool.name).startsWith('mcp__'));
  const messages = (body.messages ?? []).flatMap(partsOf);
  return {
    total: size(body),
    system: { chars: sum(system), blocks: system },
    tools: {
      chars: size(body.tools ?? []),
      builtin: { count: builtin.length, chars: sum(builtin) },
      mcp: { count: mcp.length, chars: sum(mcp) },
      list: [...tools].sort((a, b) => b.chars - a.chars),
    },
    messages: { chars: sum(messages), parts: messages },
  };
}

/**
 * Рост блока против пина, после которого бюджет красный (B.6): ~500 токенов в
 * каждом вызове каждой группы — заметно, а дрожь CLI от версии к версии меньше.
 */
export const BUDGET_SLACK = 2000;

/** Числа замера для пина бюджета — без текста запроса. */
export function budgetOf(blocks) {
  return {
    total: blocks.total,
    system: blocks.system.chars,
    tools: blocks.tools.chars,
    builtinTools: blocks.tools.builtin.chars,
    mcpTools: blocks.tools.mcp.chars,
    messages: blocks.messages.chars,
  };
}

/** Блоки, выросшие против пина больше `slack`; блок, которого нет в пине, — тоже. */
export function overBudget(pinned, now, slack = BUDGET_SLACK) {
  return Object.keys(now)
    .filter((block) => !(block in pinned) || now[block] > pinned[block] + slack)
    .map((block) => ({ block, pinned: pinned[block], now: now[block] }));
}

/** Записать замер звена; вернуть путь файла. */
export function writeGroupBase(dir, stage, body, meta = {}) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `group-base-${stage}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ stage, ...meta, ...blocksOf(body) }, null, 2)}\n`,
    'utf8',
  );
  return file;
}
