import type { ModelInfo } from '@agentdeck/contracts';
import type { ActiveRunView, RunStatus } from '@shared/lib/agent-runs';

export interface ChatHeaderProps {
  /** Заголовок открытого разговора; нет разговора — берётся имя проекта. */
  chatTitle?: string;
  projectName?: string;
  projectPath?: string;
  isProjectContext: boolean;
  /** Есть ли что открывать/обновлять: id разговора или черновика. */
  chatId?: string;
  /** Настоящий ключ разговора — для настроек чата в меню. */
  sessionId?: string;

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
  /** CLI разговора (W3-17a): не Claude — алиасов Claude в выборе модели нет. */
  cli?: string;
  /**
   * Кем прогон этого разговора пойдёт через контур: `groups` у разговора,
   * заведённого разделением, иначе `chat`. Спрашивать план всегда за «Чат»
   * значило бы обещать в группе снятые слои чужого маршрута — ровно та подпись,
   * ради которой она и заводилась (ревью Т8).
   */
  consumer: string;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;

  isEditorPending: boolean;
  onOpenEditor: (path: string) => void;
  /** Открыть окно кода проекта: дерево файлов и дифф правок этого разговора. */
  onOpenCode: () => void;
  onOpenTests: () => void;
  /** Окно «Окружение»: сервисы Docker Compose проекта. */
  onOpenEnvironment: () => void;

  allowEdits: boolean;
  onAllowEditsChange: (value: boolean) => void;
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;

  /** Статус прогона активного чата — от него зависят кнопки восстановления. */
  runStatus: RunStatus;
  /**
   * Ход упал на переполненном контексте: повтор и продолжение упрутся в него же,
   * поэтому шапка их прячет — выход из переполнения даёт карточка ошибки.
   */
  errorOverflow?: boolean;
  /** Ход упёрся в лимит окна: повтор ведёт ядро, кнопок повтора панели нет (этап 12, P171). */
  limitHolds?: boolean;
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
  /** «Перезапустить сессию» в меню шапки; пусто — разговора ещё нет. */
  onRestartSession?: () => void;
}
