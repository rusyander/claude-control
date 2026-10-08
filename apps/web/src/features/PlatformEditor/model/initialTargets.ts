import type { PlatformStatus } from '@agentdeck/contracts';
import { PLATFORM_ASSISTANT_TARGET } from '@agentdeck/contracts';

/**
 * С чего начинается выбор ФАЙЛОВЫХ целей — тех, что пишутся в конфигурацию
 * чужого CLI.
 *
 * Ассистента панели среди них больше нет (Т3): он стал потребителем маршрута и
 * отмечается в списке «Где работает контур», а держать его ещё и галочкой цели
 * значило бы спрашивать об одном и том же дважды и получать два разных ответа.
 * Новый контур начинает с пустого списка: файлы CLI пишет потребитель
 * «Терминал», а он снят по умолчанию.
 */
export function initialTargets(existing: PlatformStatus | undefined): string[] {
  const saved = existing?.platform.targets ?? [];
  return saved.filter((target) => target !== PLATFORM_ASSISTANT_TARGET);
}
