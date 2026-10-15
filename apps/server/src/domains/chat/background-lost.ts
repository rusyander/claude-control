import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import type { SplitConveyor } from './split-conveyor/split-conveyor.ts';
import type { ChatRunRegistry } from './ChatRunRegistry/ChatRunRegistry.ts';
import type { AutoContinue } from './auto-continue/auto-continue.ts';

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

/**
 * То же у ОБЫЧНОГО чата на локальной модели (L6, живой прогон 14.10): процесс ушёл,
 * держа фонового субагента, — его итога и пробуждения не будет, и ночная задача
 * стояла бы до утра. Это обрыв, как процесс без итога (`interrupted`): решает
 * продолжение L4b — только локальный прогон, не чаще его предела. Группы
 * разделения идут своим путём (`interruptOnBackgroundLost`).
 */
export function continueOnBackgroundLost(
  store: { getChatLink: (key: string) => ChatLink | undefined },
  runs: Pick<ChatRunRegistry, 'lastRunOf'>,
  autoContinue: Pick<AutoContinue, 'finished'>,
): (keys: readonly string[]) => void {
  return (keys) => {
    if (keys.some((key) => store.getChatLink(key)?.parentChatId)) return;
    const last = runs.lastRunOf(keys);
    if (!last) return;
    autoContinue.finished({
      chatId: last.chatId,
      sessionId: last.sessionId,
      ...(last.meta.projectPath ? { projectPath: last.meta.projectPath } : {}),
      ...(last.meta.origin ? { origin: last.meta.origin } : {}),
      ...(last.meta.local ? { local: true as const } : {}),
      text: '',
      ok: false,
      startedAt: Date.now(),
      options: last.options,
      contextTokens: 0,
      interrupted: true,
    });
  };
}
