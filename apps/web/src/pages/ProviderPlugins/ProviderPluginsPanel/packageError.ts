/** То же для имени npm-пакета: занятое имя, затем непригодное для конфига. */
export function packageError(
  duplicate: boolean,
  invalid: boolean,
  t: (key: string) => string,
): string | undefined {
  if (duplicate) return t('providerPlugins.packages.duplicate');
  if (invalid) return t('providerPlugins.packages.invalid');
  return undefined;
}
