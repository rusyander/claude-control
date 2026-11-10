import type { LiveTask } from '../../journal/resume.ts';
import type { CommandProof } from '../../policy/authority/authority.ts';

export type HumanChannel = 'device' | 'panel' | 'telegram';
export type HumanActor = 'human:device' | 'human:panel' | 'human:telegram';

/**
 * Канал по доказательству: подпись устройства, проверенная ядром, — устройство; пир `telegram`
 * (этап 12, D29: звено панели + отпечаток привязанного владельца) — Telegram; иначе панель.
 * Подпись старше пира: команда с годной подписью доказана ключом телефона, откуда бы ни пришла.
 */
export function channelOfProof(proof: CommandProof | undefined): {
  channel: HumanChannel;
  actor: HumanActor;
} {
  if (proof?.signature === 'valid') return { channel: 'device', actor: 'human:device' };
  if (proof?.peer === 'telegram') return { channel: 'telegram', actor: 'human:telegram' };
  return { channel: 'panel', actor: 'human:panel' };
}

/**
 * Канал команды человека — по доказательству, принятому в журнал (`command.received.proof`), а не
 * по полю конверта. Тот же выбор, что у `command.received` в `commands/process.ts`, чтобы строки
 * одной команды не расходились.
 */
export function humanChannel(
  task: Pick<LiveTask, 'state'>,
  cmdId: string,
): { channel: HumanChannel; actor: HumanActor } {
  return channelOfProof(task.state.commands[cmdId]?.proof);
}
