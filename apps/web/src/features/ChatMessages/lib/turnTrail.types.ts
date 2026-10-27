/** Субагент хода: тип, описание задачи и модель — что из них передано в вызов. */
export interface TrailAgent {
  type?: string;
  description?: string;
  model?: string;
}

/** Скрипт хода; один и тот же запуск повторами не множится, а считается. */
export interface TrailScript {
  command: string;
  /** Описание вызова Bash (`description`) — у первого запуска. */
  description?: string;
  count: number;
}

/** Хуки одного имени CLI (`PostToolUse:Bash`) за ход. */
export interface TrailHookGroup {
  hookName: string;
  /** Команды по имени со счётом; хук без имени (только контекст) сюда не входит. */
  names: { name: string; count: number }[];
  count: number;
  durationMs: number;
  /** Что хуки добавили в контекст модели — начала текстов. */
  contexts: string[];
  /** Сбой: первый ненулевой код выхода или остановка без кода. */
  failure?: { exitCode?: number };
}

/** След хода: что агент запускал и какие хуки сработали. */
export interface TurnTrail {
  skills: string[];
  agents: TrailAgent[];
  scripts: TrailScript[];
  hooks: TrailHookGroup[];
  hookCount: number;
  /** Сколько срабатываний хуков добавили контекст. */
  contextCount: number;
  hookMs: number;
}
