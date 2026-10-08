export { permissionApi, useCreatePermissions } from './api/PermissionApi';
export { useMovePermission } from './api/useMovePermission';

// Словарь решений и цвета плашек: их читают все формы и списки прав.
export { PERMISSION_DECISIONS } from './model/permissionDecisions';
export { RISK_TONE, DECISION_TONE } from './model/permissionTone';
export type { PermissionTone } from './model/permissionTone';

// Что действует на самом деле: deny > ask > allow, оба файла настроек вместе.
export { coversPattern } from './model/effectiveDecision';
export { effectiveRuleFor } from './model/effectiveRuleFor';
export { shadowedBy } from './model/shadowedBy';
export { findDuplicate } from './model/findDuplicate';
