import type { ChatProgress, ProgressActiveTool } from '@agentdeck/contracts';
import type { SplitGroupStatusView } from '@agentdeck/contracts/chat-handoff';
import type { GroupStep } from './groupStep';

/** Состояние группы на индикаторе: работает / ждёт очередь / ждёт разрешения / стоит / закончила. */
export type GroupProgressState = 'working' | 'queued' | 'permission' | 'stalled' | 'finished';

export interface GroupProgressInput {
  progress: ChatProgress | undefined;
  group: {
    isRunning: boolean;
    status?: SplitGroupStatusView;
    mrClosed?: 'merged' | 'closed';
    /** Заведение первого звена цепочки (ISO). */
    startedAt?: string;
    /** Последняя запись в цепочке (ISO). */
    lastAt?: string;
    /** Старт идущего хода (ISO): с него считается «работает». */
    runStartedAt?: string;
  };
  /** Прогон группы стоит на запросе прав — карточка ждёт человека. */
  permission: boolean;
}

export interface GroupProgressView {
  state: GroupProgressState;
  /** С каких пор группа в этом состоянии (ISO); не знаем — поля нет. */
  since?: string;
  /** Сделано и всего — по файлу шагов или плану агента; ни того ни другого — полей нет. */
  done?: number;
  total?: number;
  percent?: number;
  step?: GroupStep;
  /** Что группа делает прямо сейчас — незакрытый вызов идущего прогона. */
  tool?: ProgressActiveTool;
  /** Сколько чужих ожидающих в очереди тяжёлых шагов впереди. */
  queueAhead?: number;
}
