/**
 * Вкладки страницы раздела: какая открыта и как её запомнить.
 *
 * Правила одни на все разделы с вкладками, поэтому живут здесь, а не в каждой
 * странице: адрес (`?tab=…`) главнее памяти — ссылкой делятся ровно на то, что
 * видно; без адреса открывается запомненная вкладка, иначе первая. Незнакомое
 * значение (ссылка устарела после переименования вкладки) не даёт пустого
 * экрана и не считается ошибкой.
 */
export function pickPageTab<T extends string>(
  ids: readonly T[],
  fromUrl: unknown,
  remembered: unknown,
): T {
  const known = (value: unknown): value is T =>
    typeof value === 'string' && (ids as readonly string[]).includes(value);
  if (known(fromUrl)) return fromUrl;
  if (known(remembered)) return remembered;
  const first = ids[0];
  if (first === undefined) throw new Error('pickPageTab: у страницы нет ни одной вкладки');
  return first;
}
