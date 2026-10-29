import type { ReactNode } from 'react';
import type {
  ContinuePermissionInfo,
  CursorPermissionInfo,
  GooseMode,
  GoosePermissionInfo,
  KimiMode,
  KimiPermissionInfo,
  KimiPermissionRule,
  OpencodePermissionEntry,
  OpencodePermissionInfo,
  QwenApprovalMode,
  QwenPermissionInfo,
} from '@agentdeck/contracts';

/**
 * Типы форм прав, общих у глобального раздела и таба проекта. Лежат рядом с
 * `ProviderPermissionsPanel.types.ts` и по тому же принципу: панелей и форм
 * много, модель прав у каждой своя, а обвязка у всех одна.
 */

/** Состояние формы, по которому шапка решает, что показывать. */
interface PermissionsFormHeaderState {
  dirty: boolean;
  submit: () => void;
}

/** Шапка раздела: своя у глобальной страницы и у таба проекта. */
type PermissionsFormHeader = (state: PermissionsFormHeaderState) => ReactNode;

/** Черновик прав Continue, который форма отдаёт наружу на сохранение. */
interface ContinuePermissionsDraft {
  allow: string[];
  ask: string[];
  exclude: string[];
}

export interface ContinuePermissionsFormProps {
  data: ContinuePermissionInfo;
  onSave: (draft: ContinuePermissionsDraft) => void;
  header: PermissionsFormHeader;
}

/** Черновик прав Cursor, который форма отдаёт наружу на сохранение. */
interface CursorPermissionsDraft {
  allow: string[];
  deny: string[];
}

export interface CursorPermissionsFormProps {
  data: CursorPermissionInfo;
  onSave: (draft: CursorPermissionsDraft) => void;
  header: PermissionsFormHeader;
}

/** Черновик прав Goose, который форма отдаёт наружу на сохранение. */
interface GoosePermissionsDraft {
  mode: GooseMode;
}

export interface GoosePermissionsFormProps {
  data: GoosePermissionInfo;
  onSave: (draft: GoosePermissionsDraft) => void;
  header: PermissionsFormHeader;
}

/** Черновик прав Kimi Code, который форма отдаёт наружу на сохранение. */
interface KimiPermissionsDraft {
  mode: KimiMode;
  rules: KimiPermissionRule[];
}

export interface KimiPermissionsFormProps {
  data: KimiPermissionInfo;
  onSave: (draft: KimiPermissionsDraft) => void;
  header: PermissionsFormHeader;
}

export interface OpencodePermissionsFormProps {
  data: OpencodePermissionInfo;
  header: PermissionsFormHeader;
  onSave: (entries: OpencodePermissionEntry[]) => void;
}

/** Черновик прав Qwen Code, который форма отдаёт наружу на сохранение. */
interface QwenPermissionsDraft {
  approvalMode: QwenApprovalMode;
  allow: string[];
  ask: string[];
  deny: string[];
}

export interface QwenPermissionsFormProps {
  data: QwenPermissionInfo;
  onSave: (draft: QwenPermissionsDraft) => void;
  header: PermissionsFormHeader;
}
