/** Типы для `path-lookup.mjs` — сам файл без типов: его читает `tools/doctor.mjs` голым Node. */

export function posixPathMatches(
  command: string,
  pathVar?: string,
  isExecutable?: (path: string) => boolean,
): string[];
