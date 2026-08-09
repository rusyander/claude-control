import type { ModelInfo } from '@claude-control/contracts';
import type { ActiveRunView, RunStatus } from '@shared/lib/agent-runs';

export interface ChatHeaderProps {
  /** Заголовок открытого разговора; нет разговора — берётся имя проекта. */
  chatTitle?: string;
  projectName?: string;
  projectPath?: string;
  isProjectContext: boolean;
  /** Есть ли что открывать/обновлять: id разговора или черновика. */
  chatId?: string;

  activeRuns: ActiveRunView[];
  totalCost: number;
  totalTokens: number;
  costUnit: 'tokens' | 'money';
  onStopRun: (id: string) => void;
  onStopAllRuns: () => void;
  onViewRun: (run: ActiveRunView) => void;

  /** Оверрайды модели и глубины для этого чата ('' = брать из настроек). */
  model: string;
  effort: string;
  defaultModel: string;
  defaultEffort: string;
  models?: ModelInfo[];
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;

  isEditorPending: boolean;
  onOpenEditor: (path: string) => void;
  /** Открыть окно кода проекта: дерево файлов и дифф правок этого разговора. */
  onOpenCode: () => void;
  onOpenTests: () => void;

  allowEdits: boolean;
  onAllowEditsChange: (value: boolean) => void;
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;

  /** Статус прогона активного чата — от него зависят кнопки восстановления. */
  runStatus: RunStatus;
  onRetry: () => void;
  onContinue: () => void;
  onAllowAndContinue: () => void;

  tokens: number;
  costUsd?: number;
  /** Unix-секунды сброса лимита — показываем временем в бейдже. */
  limitResetsAt?: number;

  /** Разговор сохранён, его можно выгрузить файлом. */
  canExport: boolean;
  onExport: () => void;
  onRefresh: () => void;
}
