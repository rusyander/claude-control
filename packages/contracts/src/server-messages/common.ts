/** Коды текстов сервера, раздел «common»: Общие отказы: файлы, каталоги, проекты. Сборка всех — `../server-messages.ts`. */
export const commonMessageParams = {
  'file-not-found': [],
  'path-absolute-required': [],
  'directory-unavailable': [],
  'directory-not-found': [],
  'project-path-required': [],
  'project-not-in-registry': [],
  'project-id-not-in-registry': [],
  'project-dir-already-added': ['name'],
} as const satisfies Record<string, readonly string[]>;
