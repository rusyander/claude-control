import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { SplitConveyor } from './split-conveyor.ts';

/**
 * Процесс группы разделения ушёл сам, держа фоновые задачи агента (решение
 * W3-4c), — слушатель `ChatRunRegistry.setBackgroundLostListener`.
 *
 * Группа в этот момент стоит «ждёт фон»: ход кончился, а гейт или сборка идут в
 * фоне, и продолжит группу пробуждение CLI по их концу. Процесс умер —
 * посредника сняли снаружи, CLI упал, усыновлённый после перезапуска процесс
 * не дожил до конца фона, — и пробуждения не будет никогда. Это не провал
 * работы: группа «прервана» и идёт тем же путём, что оборванный ход, —
 * самостоятельное продолжение с восстановлением состояния, пока не кончились
 * попытки (`MAX_INTERRUPT_RESUMES`). Разбор (уровень 1) — не группа.
 */
export function interruptOnBackgroundLost(
  store: { getChatLink: (key: string) => ChatLink | undefined },
  conveyor: Pick<SplitConveyor, 'onChainInterrupted'>,
): (keys: readonly string[]) => void {
  return (keys) => {
    const link = keys.map((key) => store.getChatLink(key)).find(Boolean);
    if (link?.parentChatId && link.stage !== 'triage') conveyor.onChainInterrupted(link);
  };
}
