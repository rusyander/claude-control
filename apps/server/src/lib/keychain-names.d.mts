/** Типы для `keychain-names.mjs` — сам файл без типов: его читает `tools/doctor.mjs` голым Node. */

export function keychainServiceNames(
  configRoot: string,
  env?: NodeJS.ProcessEnv,
  defaultRoot?: string,
): string[];
