/**
 * Копия единицы (04:97-99, G7): выкладка от закреплённой базы (`create`), настройка и её решение
 * `copy-setup` (`setup` → `decide`), снятие с чтением назад (`remove`). Перенесено из панели
 * (`project-git/{bootstrap,bootstrap-log,mirror-local,lockfiles,worktrees,default-base}`), код
 * панели ядро не импортирует.
 */
export type * from './copy.types.ts';
export {
  createUnitCopy,
  journalCopySetup,
  prepareUnitCopy,
  type PrepareOptions,
} from './create.ts';
export { decideCopySetup } from './decide.ts';
export {
  planInstall,
  REQUIREMENT_FILES,
  venvPython,
  type ConfiguredInstall,
} from './install-plan.ts';
export { journaledSetup, pinnedBaseOf, unitCopyOf, unitRepoOf } from './journal-view.ts';
export { copyDirFor, worktreeDirName } from './location.ts';
export { firstErrorLine, logTail, quietLog } from './log.ts';
export { mirrorLocalLayer } from './mirror.ts';
export { DEFAULT_EXCLUDE, DEFAULT_INCLUDE, planMirror } from './mirror-plan.ts';
export { removeUnitCopy, type CopyRemoveInput, type CopyRemoveResult } from './remove.ts';
export { LOCKFILES, setupCopy, type SetupDeps, type SetupInput } from './setup.ts';
