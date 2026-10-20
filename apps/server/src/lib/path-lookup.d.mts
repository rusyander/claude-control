/** Типы для `path-lookup.mjs` — сам файл без типов: его читает `tools/doctor.mjs` голым Node. */

/** Обычный файл (по ссылке — её цель) с правом на исполнение. */
export function isExecutableFile(path: string): boolean;

export function posixPathMatches(
  command: string,
  pathVar?: string,
  isExecutable?: (path: string) => boolean,
): string[];
