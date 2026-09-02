import { existsSync, readFileSync } from 'node:fs';

/**
 * Описание скрипта — первый блок комментария в шапке файла. Один разбор на две
 * страницы: «Скрипты» показывает его в строке списка, «Хуки» — под командой
 * хука. Раньше разборов было два, и один файл получал два разных описания:
 * страница хуков не пропускала shebang и показывала `!/usr/bin/env node`, а
 * страница скриптов принимала закрывающую строку блочного комментария за
 * строку текста и дописывала к описанию хвост « /».
 *
 * Понимает `#!` (пропуск), `//`, `#`, блочный комментарий JS и `<# … #>`
 * PowerShell. Служебная строка «Событие: … Claude Control» из файлов, созданных
 * панелью раньше, описанием не считается.
 */
export function readScriptDescription(scriptPath: string): string | undefined {
  if (!existsSync(scriptPath)) return undefined;
  try {
    return describeScript(readFileSync(scriptPath, 'utf8'));
  } catch {
    return undefined;
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
const LEGACY_EVENT_LINE = /^Событие: .*Claude Control/;

/** Описание из текста файла — вынесено ради тестов без диска. */
export function describeScript(text: string): string | undefined {
  const comments: string[] = [];
  const push = (body: string): void => {
    const clean = body.trim();
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

  return comments.join(' ').trim() || undefined;
}
