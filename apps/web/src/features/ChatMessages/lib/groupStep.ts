import type { ChatProgress } from '@agentdeck/contracts';

/** Где группа на своём пути: номер шага по плану агента и чем он ведётся. */
export interface GroupStep {
  /**
   * Номер шага, который идёт сейчас (или последнего сделанного, если все
   * сделаны), и сколько их всего. Нет — плана у агента нет, шаг назван по навыку.
   */
  current?: number;
  total?: number;
  /** Название нынешнего шага — первый пункт плана «в работе». */
  name?: string;
  /** Сколько субагентов работает на этом шаге прямо сейчас. */
  agents: number;
}

/**
 * Шаг группы из плана агента (живой прогон 29.09: человек спрашивал «на каком
 * этапе группа» и открывал каждый чат). План — чекпоинты, которые агент сам
 * себе ставит по правилам своей задачи, поэтому «8 из 14» считается по ним, а не
 * по звеньям конвейера: звеньев четыре, шагов у доставки тикета — четырнадцать.
 * Плана нет — шага нет, а не «0 из 0». Файл шагов в копии группы сильнее плана.
 */
export function groupStep(
  progress: ChatProgress | undefined,
  isRunning: boolean,
): GroupStep | undefined {
  const tasks = progress?.tasks ?? [];
  const running = (progress?.agents ?? []).filter((agent) => agent.status === 'running');
  const agents = running.length;
  // Файл шагов (`.agent/steps.json`) пишет навык проекта — он знает свой путь
  // лучше, чем план агента, поэтому идёт первым (решение владельца 29.09).
  const steps = progress?.steps;
  if (steps) {
    return {
      current: steps.current,
      total: steps.total,
      ...(steps.title ? { name: steps.title } : {}),
      agents,
    };
  }
  if (tasks.length === 0) {
    // Ревью 29.09: агенты групп плана (TodoWrite) не ведут вовсе. Тогда шаг —
    // навык, которым агент работает, а без него — задача живых субагентов;
    // номера нет, потому что считать его не по чему. Только у идущей группы:
    // у стоящей навык — то, чем она работала когда-то, а не где она сейчас
    // (холодная проверка 29.09, N4).
    if (!isRunning) return undefined;
    const name = progress?.skill?.name ?? running[0]?.description;
    return name ? { name, agents } : undefined;
  }
  const done = tasks.filter((task) => task.status === 'completed').length;
  const active = tasks.findIndex((task) => task.status === 'in_progress');
  const name = active >= 0 ? tasks[active]?.text : undefined;
  return {
    current: active >= 0 ? active + 1 : Math.max(done, 1),
    total: tasks.length,
    ...(name ? { name } : {}),
    agents,
  };
}
