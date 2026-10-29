import { basename } from 'node:path';
import { CAPTURE_SHIM } from './capture-shim.ts';
import { quoteNodeOption } from './spawn.ts';

/** Слово `NODE_OPTIONS`: значение после разбора кавычек и написание как было. */
export interface NodeOptionWord {
  value: string;
  raw: string;
}

/**
 * Слова `NODE_OPTIONS` так, как их режет сам node: пробелы делят, двойные кавычки держат слово,
 * обратная косая внутри кавычек экранирует следующий знак (проверено живьём: путь Windows без
 * удвоения косых внутри кавычек ломается). `raw` — написание слова как было, для пересборки.
 */
export function splitNodeOptions(text: string): NodeOptionWord[] {
  const words: NodeOptionWord[] = [];
  let value = '';
  let raw = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]!;
    if (quoted && c === '\\' && i + 1 < text.length) {
      value += text[i + 1];
      raw += c + text[i + 1];
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = !quoted;
      raw += c;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(c)) {
      if (started) words.push({ value, raw });
      value = '';
      raw = '';
      started = false;
      continue;
    }
    value += c;
    raw += c;
    started = true;
  }
  if (started) words.push({ value, raw });
  return words;
}

const isShim = (file: string): boolean =>
  basename(file.replace(/\\/g, '/')) === basename(CAPTURE_SHIM);

/** Записи `NODE_OPTIONS` без прокладки захвата (любого пути — прежняя установка из другой копии). */
export function withoutCaptureRequire(previous: string | undefined): string {
  const words = splitNodeOptions(previous ?? '');
  const kept: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    if ((word.value === '--require' || word.value === '-r') && i + 1 < words.length) {
      const file = words[i + 1]!;
      if (!isShim(file.value)) kept.push(word.raw, file.raw);
      i += 1;
      continue;
    }
    if (word.value.startsWith('--require=') && isShim(word.value.slice('--require='.length))) {
      continue;
    }
    kept.push(word.raw);
  }
  return kept.join(' ');
}

/**
 * `NODE_OPTIONS` с прокладкой ПЕРВОЙ (G22): чужие записи (`--max-old-space-size`, прежний
 * `--require` журнала) остаются после неё, прежняя запись прокладки — выброшена, а не задвоена.
 * Путь — в двойных кавычках с экранированием (`quoteNodeOption`, P54: пробел и кириллица в пути).
 */
export function composeCaptureNodeOptions(
  previous: string | undefined,
  shim: string = CAPTURE_SHIM,
): string {
  const rest = withoutCaptureRequire(previous);
  return [`--require ${quoteNodeOption(shim)}`, rest].filter(Boolean).join(' ');
}
