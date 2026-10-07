/** Типы для `provider-cli-names.mjs` — сам файл без типов: его читает `tools/doctor.mjs` голым Node. */

export interface ProviderCliName {
  id: string;
  name: string;
  command: string;
  windowsCommand: string;
}

export const PROVIDER_CLI_NAMES: ProviderCliName[];
