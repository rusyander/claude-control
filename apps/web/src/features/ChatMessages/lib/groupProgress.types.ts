import type { ChatProgress, ProgressActiveTool } from '@agentdeck/contracts';
import type { GroupStep } from './groupStep';

/** Состояние группы на индикаторе: работает / ждёт разрешения / стоит. */
type GroupProgressState = 'working' | 'permission' | 'stalled';

export interface GroupProgressInput {
  progress: ChatProgress | undefined;
  group: {
    isRunning: boolean;
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
}
