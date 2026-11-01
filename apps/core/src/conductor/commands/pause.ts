import type { ApplyCommand } from './commands.types.ts';
import { taskEvent } from './task-machine.ts';

/**
 * Пауза (G10): событие `pause` машины задачи, и только оно. Как снимать сессии, решает
 * `conductor/next` по свёртке: `now` (поле команды в `command.received`, свёртка `pause.now`) —
 * дерево сразу; иначе — в безопасной точке (`conductor/safepoint`). Здесь сессий не трогаем:
 * команда отвечает сразу, снятие — действие исполнителя с его строкой в журнале.
 */
export const applyPause: ApplyCommand = taskEvent('pause');
