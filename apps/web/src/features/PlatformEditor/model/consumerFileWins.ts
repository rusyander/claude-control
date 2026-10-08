import type { PlatformConsumerOption } from '@agentdeck/contracts';
import { foreignProviderId } from '@agentdeck/contracts';

/**
 * Файл CLI сильнее снятой галочки потребителя: переменные панель кладёт в
 * окружение процесса, а применённый файл CLI читает сам на каждом запуске.
 * Пока файл этого CLI применён, «через контур не ходить» для такого прогона не
 * выполнится — это говорится у строки, а не обещается молча.
 */
export function consumerFileWins(
  consumer: PlatformConsumerOption,
  consumers: readonly string[],
  appliedFiles: ReadonlySet<string>,
): boolean {
  return (
    consumer.scope === 'run' &&
    !consumers.includes(consumer.id) &&
    appliedFiles.has(foreignProviderId(consumer.id) ?? 'claude')
  );
}
