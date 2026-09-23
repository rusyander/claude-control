import type { ChatProgress, ProgressActiveTool, ProgressShell } from '@agentdeck/contracts';

/**
 * Чистая выжимка для шапки панели прогресса. Вынесена из компонента, чтобы
 * считалась и проверялась отдельно от разметки: «сколько сделано» — это то, ради
 * чего панель вообще открывают, и ошибиться в счёте здесь дороже всего.
 */
export interface ProgressSummary {
  total: number;
  done: number;
  /** Чекпоинт, который агент делает прямо сейчас (первый in_progress). */
  current?: string;
  /** Сколько субагентов ещё работает — по ним видно, что дерево живое. */
  agentsRunning: number;
  agentsTotal: number;
  /** Вызов, который идёт прямо сейчас. Только у живого прогона. */
  activeTool?: ProgressActiveTool;
  /** Фоновые команды, которые идут прямо сейчас. */
  shellsRunning: number;
  /** Фоновые команды, умершие вместе с процессом разговора, — их результата не будет. */
  shellsLost: number;
  /** Показывать ли панель вообще: пустой план — пустая полоса внизу экрана. */
  hasAnything: boolean;
}

/**
 * Что стало с фоновой командой — с поправкой на процесс. Фон живёт, пока жив
 * процесс CLI разговора (он переживает ходы), а уведомление об обрыве пишет
 * только следующий процесс. Поэтому `running` из транскрипта при мёртвом
 * процессе значит «оборвана». Сервер без признака (старый) — судим по прогону.
 */
export type ShellView = ProgressShell['status'] | 'lost';

export function shellView(
  shell: ProgressShell,
  isRunning: boolean,
  processAlive: boolean | undefined = undefined,
): ShellView {
  const alive = processAlive ?? isRunning;
  if (shell.status === 'running' && !alive && !isRunning) return 'lost';
  return shell.status;
}

export function summarizeProgress(
  progress: ChatProgress | undefined,
  isRunning = false,
): ProgressSummary {
  const tasks = progress?.tasks ?? [];
  const agents = progress?.agents ?? [];
  const shells = (progress?.shells ?? []).map((shell) =>
    shellView(shell, isRunning, progress?.processAlive),
  );
  const activeTool = isRunning ? progress?.activeTool : undefined;

  return {
    total: tasks.length,
    done: tasks.filter((task) => task.status === 'completed').length,
    current: tasks.find((task) => task.status === 'in_progress')?.text,
    agentsRunning: agents.filter((agent) => agent.status === 'running').length,
    agentsTotal: agents.length,
    ...(activeTool ? { activeTool } : {}),
    shellsRunning: shells.filter((status) => status === 'running').length,
    shellsLost: shells.filter((status) => status === 'lost' || status === 'stopped').length,
    hasAnything: tasks.length > 0 || agents.length > 0 || shells.length > 0 || Boolean(activeTool),
  };
}

/** Сколько идёт то, что стартовало в `startedAt`, — к моменту `now`. */
export function elapsedMs(startedAt: string | undefined, now: number): number | undefined {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isNaN(start) ? undefined : Math.max(0, now - start);
}
