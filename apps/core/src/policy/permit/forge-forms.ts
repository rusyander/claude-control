import { commandName } from './exec-argv/marks.ts';

/**
 * Флаги форджа ДО глагола (`gh -R o/r pr create`, `glab --repo o/r ci status`): cobra принимает
 * их в любом месте, а префикс argv смотрит слова подряд — форма проходила мимо запрета. Судья
 * не знает, какой флаг берёт значение отдельным словом, поэтому перебирает обе трактовки
 * (флаг один или флаг + значение) — лишний отказ лучше пропущенной публикации.
 */

const FORGES = new Set(['gh', 'glab']);
/** Предел ветвлений: длиннее — форма как есть плюс форма без всех флагов (fail-closed выше). */
const MAX_FORMS = 64;

export function forgeFlagForms(form: readonly string[]): string[][] {
  const head = form[0];
  if (head === undefined || !FORGES.has(commandName(head))) return [[...form]];
  const out: string[][] = [[...form]];
  const seen = new Set([form.join('\u0000')]);
  const walk = (i: number, acc: string[]): void => {
    if (out.length >= MAX_FORMS) return;
    // Первое слово без дефиса — глагол: дальше форма как есть, флаги после глагола префикс видит.
    const word = form[i];
    if (word === undefined || !word.startsWith('-') || word === '-' || word === '--') {
      const next = [...acc, ...form.slice(i)];
      const key = next.join('\u0000');
      if (!seen.has(key)) {
        seen.add(key);
        out.push(next);
      }
      return;
    }
    walk(i + 1, acc);
    if (!word.includes('=')) walk(i + 2, acc);
  };
  walk(1, [head]);
  return out;
}
