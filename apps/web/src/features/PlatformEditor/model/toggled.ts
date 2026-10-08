/** Отметить или снять: один и тот же щелчок по строке списка. */
export function toggled(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((item) => item !== id) : [...list, id];
}
