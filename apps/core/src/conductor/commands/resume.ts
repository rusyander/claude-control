import type { ApplyCommand } from './commands.types.ts';
import { taskEvent } from './task-machine.ts';

/**
 * Продолжение (G10): событие `resume` машины задачи. Дальше — то же, что после перезапуска ядра
 * (P11): `next` видит шаг без живой сессии и велит `run-step`; памяти паузы вне журнала нет.
 */
export const applyResume: ApplyCommand = taskEvent('resume');
