/**
 * «Другое» при нескольких вариантах: свой текст встаёт вместо прежнего своего.
 * Текст, совпавший с готовым вариантом, — это сам вариант: он отмечается один
 * раз, а своего ответа нет. Прежнее выражение давало `['A','A']` и вторую
 * строку «моё» с тем же именем (F-154).
 */
export function applyOtherAnswer(input: {
  picked: readonly string[];
  custom: string;
  text: string;
  known: ReadonlySet<string>;
}): { picked: string[]; custom: string } {
  const { picked, custom, text, known } = input;
  const rest = picked.filter((item) => item !== custom && item !== text);
  return { picked: [...rest, text], custom: known.has(text) ? '' : text };
}
