import type { EnvSource } from '@agentdeck/contracts';

const ENV_FILE_NAMES: Partial<Record<EnvSource, string>> = {
  settings: 'settings.json',
  'settings-local': 'settings.local.json',
  secrets: '.mcp-secrets.env',
};

/** Имя файла за источником — то, что человек видит в бейдже и в форме, а не слово из enum. */
export const envFileName = (source: EnvSource): string => ENV_FILE_NAMES[source] ?? source;

/**
 * Сохранённое значение секрета не дочиталось. Ключом, а не готовой фразой: текст
 * причины переводит форма, иначе английский интерфейс получал русскую строку.
 */
export class SecretRevealError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`Не удалось прочитать сохранённое значение ${key}`);
    this.key = key;
    this.name = 'SecretRevealError';
  }
}
