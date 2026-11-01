import type { ApplyCommand } from './commands.types.ts';
import { taskEvent } from './task-machine.ts';

/**
 * Отмена: событие `cancel`; конец машины пишет `task.ended` (P17).
 */
export const applyCancel: ApplyCommand = taskEvent('cancel');
