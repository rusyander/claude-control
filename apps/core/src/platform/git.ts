/**
 * git для проверок ядра (04, этап 3): строки дерева для ключа, общий каталог для хранилища
 * записей, отделённая копия для прогона на базе, входы вне git и файлы хранилища. Фасад над
 * `git/` — различия ОС (длинные пути, кодировка вывода, регистр имён окружения) остаются здесь.
 */
export { commonDir, commonDirSync, workTreeOf, type WorkTreeOf } from './git/common-dir.ts';
export { changedPaths, diffFileOf, diffUnit } from './git/diff.ts';
export { inputDigests } from './git/inputs.ts';
export { git, gitEnv } from './git/run.ts';
export { createOnceLinked, listStoreDir, readStoreFile } from './git/store-files.ts';
export { parseLsTree, scratchIndexTree, treeRows } from './git/tree.ts';
export { addDetachedWorktree } from './git/worktree.ts';
export type { GitOptions, GitRunner, TreeRev, TreeRow, WorktreeAdd } from './git/git.types.ts';
