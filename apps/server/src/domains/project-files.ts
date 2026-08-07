/**
 * Файлы проекта, открытого в чате: дерево, содержимое, запись и дифф правок
 * агента за этот разговор.
 *
 * Фасад над `project-files/`: пути и защита обхода каталога (`paths`), обзор по
 * уровню (`tree`), чтение файла вместе с базой сравнения (`content`), сводка
 * изменённых файлов (`changes`), запись с копией и проверкой свежести (`write`),
 * разбор правок из транскрипта (`edits`).
 *
 * О чате домен не знает ничего: записи транскрипта приходят структурным типом,
 * а склеивает их с разговором маршрут. Так домен проверяется в одиночку, а
 * граница слоёв остаётся ровно там, где объявлена.
 */

export { ProjectFileError, relativeToProject, resolveProjectPath } from './project-files/paths.ts';
export { listProjectDir } from './project-files/tree.ts';
export { readProjectFile } from './project-files/content.ts';
export { previewKindOf, readProjectMedia } from './project-files/media.ts';
export { readProjectChanges } from './project-files/changes.ts';
export { StaleFileError, saveProjectFile } from './project-files/write.ts';
export { collectAgentEdits, rebuildBaseline } from './project-files/edits.ts';
export type { AgentEdit, CollectedEdits, TranscriptLike } from './project-files/edits.ts';
