/** Отметить или снять кейс: отметки — набор, а не список, повторов в нём нет. */
export function toggleChecked(checked: string[], id: string): string[] {
  return checked.includes(id) ? checked.filter((item) => item !== id) : [...checked, id];
}
