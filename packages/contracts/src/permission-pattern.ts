/**
 * Разберёт ли Claude Code шаблон права как «инструмент» или «инструмент(уточнение)».
 *
 * Повторяет разбор самого CLI (проверено на claude 2.1.282): уточнение — всё
 * между ПЕРВОЙ открывающей и ПОСЛЕДНЕЙ закрывающей скобкой, поэтому скобка без
 * пары ВНУТРИ уточнения законна — `Bash(echo "(":*)`, `Bash(grep -E ")":*)`.
 * Прежняя проверка на парность отказывала в таких правилах, хотя CLI их
 * принимает. Опечатка, которую CLI не разберёт и правило молча не сработает, —
 * это скобка в имени инструмента, незакрытое уточнение и хвост после `)`.
 * Скобка, экранированная обратной косой (`\(`), скобкой разбора не считается.
 */
export function permissionPatternWellFormed(pattern: string): boolean {
  const open = firstUnescaped(pattern, '(');
  const close = lastUnescaped(pattern, ')');
  if (open === -1 && close === -1) return true;
  if (open <= 0 || close !== pattern.length - 1 || close <= open) return false;
  return !/[()]/.test(pattern.slice(0, open));
}

/** Экранирована ли позиция: перед ней нечётное число обратных косых. */
function escaped(text: string, index: number): boolean {
  let slashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === '\\'; at -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function firstUnescaped(text: string, char: string): number {
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === char && !escaped(text, at)) return at;
  }
  return -1;
}

function lastUnescaped(text: string, char: string): number {
  for (let at = text.length - 1; at >= 0; at -= 1) {
    if (text[at] === char && !escaped(text, at)) return at;
  }
  return -1;
}
