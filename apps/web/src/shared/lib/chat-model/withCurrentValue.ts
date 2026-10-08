/**
 * Гарантировать, что выбранное значение есть в списке. Каталог мог не
 * скачаться (нет сети), а модель в настройках уже стоит — без этой страховки
 * выпадающий список показал бы чужое значение вместо неё.
 */
export function withCurrentValue(
  options: Array<{ value: string; label: string }>,
  value: string,
): Array<{ value: string; label: string }> {
  if (!value || options.some((option) => option.value === value)) return options;
  return [...options, { value, label: value }];
}
