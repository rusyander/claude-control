import { existsSync, readFileSync } from 'node:fs';
import { BRAND_NAME, LEGACY_BRAND_NAME } from '../brand.mjs';

/**
 * Описание скрипта — первый блок комментария в шапке файла. Один разбор на две
 * страницы: «Скрипты» показывает его в строке списка, «Хуки» — под командой
 * хука. Раньше разборов было два, и один файл получал два разных описания:
 * страница хуков не пропускала shebang и показывала `!/usr/bin/env node`, а
 * страница скриптов принимала закрывающую строку блочного комментария за
 * строку текста и дописывала к описанию хвост « /».
 *
 * Понимает `#!` (пропуск), `//`, `#`, блочный комментарий JS и `<# … #>`
 * PowerShell. Служебная строка «Событие: … AgentDeck» из файлов, созданных
 * панелью раньше, описанием не считается.
 */
export function readScriptDescription(scriptPath: string): string | undefined {
  return readScriptDescriptionCoded(scriptPath).description;
}

/** Описание и код его перевода (`@description-code`) — для страницы «Хуки». */
export interface CodedScriptDescription {
  description?: string;
  descriptionCode?: string;
}

/**
 * Шапка скрипта, который панель пишет сама (хук телефона, хук блока «Тесты»),
 * русская — её читает человек в файле. Строка `@description-code <код>` в шапке
 * даёт интерфейсу код перевода; без неё под en описание показывалось по-русски.
 * Сама строка в описание не входит.
 */
export function readScriptDescriptionCoded(scriptPath: string): CodedScriptDescription {
  if (!existsSync(scriptPath)) return {};
  try {
    return describeScriptCoded(readFileSync(scriptPath, 'utf8'));
  } catch {
    return {};
  }
}

const HEAD_LINES = 12;
/** Открывающая скобка блочного комментария; остаток строки — в группе. */
const BLOCK_OPENER = /^(?:\/\*\*?|<#)\s?(.*)$/;
/** Закрывающая скобка блока где-то в строке. */
const BLOCK_CLOSER = /\*\/|#>/;
/** Строчный комментарий; текст — в группе. */
const LINE_COMMENT = /^(?:\/\/|#)\s?(.*)$/;
/** Служебная строка файлов, созданных панелью раньше: описание — не она. */
const LEGACY_EVENT_LINE = new RegExp(`^Событие: .*(?:${BRAND_NAME}|${LEGACY_BRAND_NAME})`);

/** Строка кода перевода описания; код — в группе. */
const DESCRIPTION_CODE_LINE = /^@description-code\s+([\w-]+)$/;
/**
 * Комментарий-указание инструменту (`/* global … *\/` для eslint и родня) — не
 * текст для человека: шапка хука телефона кончалась на «global process, fetch…».
 */
const DIRECTIVE =
  /^(?:globals?\s+[\w$]+(?:\s*:\s*\w+)?(?:\s*,\s*[\w$]+(?:\s*:\s*\w+)?)*|(?:eslint(?:-[\w-]+)?|jshint|exported|@ts-[\w-]+)(?:\s.*)?|prettier-ignore)$/;

/** Описание из текста файла — вынесено ради тестов без диска. */
export function describeScript(text: string): string | undefined {
  return describeScriptCoded(text).description;
}

export function describeScriptCoded(text: string): CodedScriptDescription {
  const comments: string[] = [];
  let descriptionCode: string | undefined;
  const push = (body: string): void => {
    const clean = body.trim();
    const code = DESCRIPTION_CODE_LINE.exec(clean);
    if (code) {
      descriptionCode = code[1];
      return;
    }
    if (clean && !LEGACY_EVENT_LINE.test(clean)) comments.push(clean);
  };

  let inBlock = false;
  for (const raw of text.split(/\r?\n/).slice(0, HEAD_LINES)) {
    const line = raw.trim();
    if (line.startsWith('#!')) continue;

    if (inBlock) {
      // Внутри блока строка — текст (звёздочка отступа JSDoc снимается) до
      // закрывающей скобки; сама скобка закрывает и описание.
      const closeAt = line.search(BLOCK_CLOSER);
      push((closeAt >= 0 ? line.slice(0, closeAt) : line).replace(/^\*\s?/, ''));
      if (closeAt >= 0) {
        inBlock = false;
        if (comments.length > 0) break;
      }
      continue;
    }

    const opener = BLOCK_OPENER.exec(line);
    // Указание инструменту — как строка кода: после текста закрывает описание.
    const body = opener?.[1] ?? LINE_COMMENT.exec(line)?.[1] ?? '';
    if (DIRECTIVE.test(body.split(BLOCK_CLOSER)[0]!.trim())) {
      if (comments.length > 0) break;
      continue;
    }
    if (opener) {
      const rest = opener[1] ?? '';
      const closeAt = rest.search(BLOCK_CLOSER);
      push(closeAt >= 0 ? rest.slice(0, closeAt) : rest);
      if (closeAt < 0) inBlock = true;
      else if (comments.length > 0) break;
      continue;
    }

    const lineComment = LINE_COMMENT.exec(line);
    if (lineComment) {
      push(lineComment[1] ?? '');
      continue;
    }

    // Первая строка кода (или пустая) после комментариев закрывает описание;
    // до первого комментария такие строки просто пропускаются.
    if (comments.length > 0) break;
  }

  const description = comments.join(' ').trim() || undefined;
  return {
    ...(description ? { description } : {}),
    ...(descriptionCode ? { descriptionCode } : {}),
  };
}
