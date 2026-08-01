export { useProviderPermissions, useSaveProviderPermissions } from './api/ProviderPermissionsApi';

// Списки правил ↔ текст: общая механика форм Gemini/Qwen/Continue/Cursor и таба проекта.
export { listToText, textToList, sameList } from './lib/permissionLists';

// Нормализация формы прав OpenCode: состояние формы ↔ записи файла.
export {
  toOpencodeFormState,
  toOpencodeEntries,
  stableOpencodeEntries,
} from './lib/opencodePermissionForm';
export type {
  OpencodeToolChoice,
  OpencodePatternRow,
  OpencodeFormState,
} from './lib/opencodePermissionForm';

// Нормализация формы прав Kimi: строки формы ↔ массив правил (порядок значим).
export { toKimiRuleRows, toKimiRules, stableKimiRules } from './lib/kimiPermissionForm';
export type { KimiRuleRow } from './lib/kimiPermissionForm';
