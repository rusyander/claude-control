export { useProviderPermissions } from './api/ProviderPermissionsApi';
export { useSaveProviderPermissions } from './api/useSaveProviderPermissions';

// Списки правил ↔ текст: общая механика форм Gemini/Qwen/Continue/Cursor и таба проекта.
export { listToText } from './lib/permissionLists';
export { sameList } from './lib/sameList';
export { textToList } from './lib/textToList';

// Правила Continue, которые cn примет, но не применит (уточнение у Read/Write/List).
export { continueUnenforced } from './lib/continueUnenforced';

// Нормализация формы прав OpenCode: состояние формы ↔ записи файла.
export { toOpencodeFormState } from './lib/opencodePermissionForm';
export { toOpencodeEntries } from './lib/toOpencodeEntries';
export { stableOpencodeEntries } from './lib/stableOpencodeEntries';
export type { OpencodeFormState } from './lib/opencodePermissionForm.types';
export type { OpencodePatternRow } from './lib/opencodePermissionForm.types';
export type { OpencodeToolChoice } from './lib/opencodePermissionForm.types';

// Нормализация формы прав Kimi: строки формы ↔ массив правил (порядок значим).
export { toKimiRuleRows } from './lib/kimiPermissionForm';
export { toKimiRules } from './lib/toKimiRules';
export { stableKimiRules } from './lib/stableKimiRules';
export type { KimiRuleRow } from './lib/kimiPermissionForm.types';
