/**
 * Параметр `tab` сырого адреса нужно заменить открытой вкладкой: он есть и
 * не равен ей. Сырой — потому что `?tab=1` роутер разбирает числом, и
 * разобранный адрес страницы его уже не несёт, а в строке браузера он
 * остаётся (F-337).
 */
export function unknownTabParam(raw: unknown, active: string): boolean {
  return raw !== undefined && raw !== active;
}
