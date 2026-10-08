export function mutedFilter(value: string): boolean | undefined {
  if (value === 'only') return true;
  if (value === 'without') return false;
  return undefined;
}
