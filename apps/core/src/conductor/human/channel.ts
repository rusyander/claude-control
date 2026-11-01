import type { LiveTask } from '../../journal/resume.ts';

/**
 * Канал команды человека — по доказательству, принятому в журнал (`command.received.proof`), а не
 * по полю конверта: подпись проверена ядром — устройство, иначе панель. Тот же выбор, что у
 * `command.received` в `commands/process.ts`, чтобы строки одной команды не расходились.
 */
export function humanChannel(
  task: Pick<LiveTask, 'state'>,
  cmdId: string,
): { channel: 'device' | 'panel'; actor: 'human:device' | 'human:panel' } {
  const valid = task.state.commands[cmdId]?.proof.signature === 'valid';
  return valid
    ? { channel: 'device', actor: 'human:device' }
    : { channel: 'panel', actor: 'human:panel' };
}
