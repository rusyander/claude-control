import type { ProjectGitFileStatus } from '@claude-control/contracts';

/** Потолок ожидания одной команды git. Хуки коммита бывают долгими, но не вечными. */
export const GIT_TIMEOUT_MS = 60_000;
/** Для `pull` потолок другой: это поход в сеть, а не локальная операция. */
export const GIT_NETWORK_TIMEOUT_MS = 180_000;
/**
 * Сколько изменённых файлов показываем списком. Полное число живёт в
 * `dirtyCount` и не обрезается: счётчик обязан быть честным, даже когда список
 * не поместился. Потолок нужен, чтобы после массового переформатирования ответ
 * не превратился в мегабайт путей, которые никто не прочитает.
 */
export const CHANGED_FILES_MAX = 500;
/** Потолок вывода: список веток огромного репозитория не должен съесть память. */
export const GIT_MAX_BUFFER = 4 * 1024 * 1024;
/** Длина сообщения коммита: с запасом на подробное описание, но не безразмерно. */
export const COMMIT_MESSAGE_MAX = 2000;

/** Управляющие символы (кроме перевода строки) — их не должно быть во вводе. */
// eslint-disable-next-line no-control-regex -- проверка на управляющие символы и есть смысл выражения
export const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/;
/** То же плюс пробельные — для имени ветки, где пробелов быть не может вовсе. */
// eslint-disable-next-line no-control-regex -- см. выше
export const BRANCH_FORBIDDEN = /[\s\u0000-\u001f\u007f]/;

/** Буква из `XY` порядкового статуса → человеческое состояние файла. */
export const STATUS_BY_CODE: Record<string, ProjectGitFileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'renamed',
  T: 'typechange',
};
