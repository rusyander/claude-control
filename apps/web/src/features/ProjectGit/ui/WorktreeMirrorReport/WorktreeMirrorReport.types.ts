import type { WorktreeMirrorReport } from '@entities/ProjectGit';

export interface WorktreeMirrorReportProps {
  report: WorktreeMirrorReport;
  /** Убрать отчёт с карточки копии — он одноразовый, к следующему зеркалу придёт новый. */
  onClose: () => void;
}
