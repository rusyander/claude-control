export interface ChatHeaderMenuProps {
  /** Тумблер правок показывается только в разговоре о настоящем проекте. */
  allowEdits?: boolean;
  onAllowEditsChange?: (value: boolean) => void;

  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;

  /** Разговор сохранён, его можно выгрузить файлом. */
  canExport: boolean;
  onExport: () => void;
  onRefresh: () => void;
}
