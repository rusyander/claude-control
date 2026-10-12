import type {
  BackendGuardRule,
  BackendGuardSettings,
  BackendGuardStatus,
} from '@entities/BackendGuard';

export interface BackendGuardPanelProps {
  projectPath: string;
  isOpen: boolean;
}

export interface GuardFormProps {
  projectPath: string;
  status: BackendGuardStatus;
  /** Итог последнего действия: форма после него собирается заново, текст живёт выше. */
  notice: string | undefined;
  onNotice: (notice: string | undefined) => void;
}

export interface GuardStatusCardProps {
  status: BackendGuardStatus;
  isBusy: boolean;
  onRestore: () => void;
}

export interface GuardRulesProps {
  disabled: readonly BackendGuardRule[];
  onToggle: (rule: BackendGuardRule, isOn: boolean) => void;
}

export interface GuardCheckProps {
  /** Настройки с экрана — проверка идёт по ним, даже несохранённым. */
  settings: BackendGuardSettings;
}

export interface GuardRemoveZoneProps {
  groupName: string;
  isBusy: boolean;
  onRemove: () => void;
}
