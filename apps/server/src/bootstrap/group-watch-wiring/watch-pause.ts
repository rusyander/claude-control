import { groupSignalsOf, type GroupWatch } from '@agentdeck/contracts/group-watch';
import type { ChatLink } from '../../lib/app-store/app-store.types.ts';
import { autoPauseRule } from '../../domains/chat/token-ledger/watch/group-watcher/auto-pause.ts';

/**
 * Безопасная точка паузы сторожа (F1): конец хода звена группы, когда планировщик
 * уже решил завести следующее звено. Спрашивают оба планировщика — Claude
 * (`handoff-routes`) и чужого CLI (`cascade`); `true` — звено не заводить, группа
 * встала на паузу сторожа. Вопрос человеку в конце хода сюда не доходит (это уже
 * пауза хода), а ждущий D-n группы — «человеку есть что решить»: тогда не ставим.
 */
export interface WatchPauseDeps {
  settings: () => Pick<GroupWatch, 'enabled' | 'autoPause'>;
  /** Блок сигналов группы, как его хранит сторож (`getGroupWatchSignals`). */
  signals: (parentChatId: string, groupIndex: number) => unknown;
  /** Группа ждёт решения человека по D-n. */
  humanWaits: (parentChatId: string, groupIndex: number) => boolean;
  /** Поставить паузу сторожа (конвейер); `false` — группа не идёт или у неё живой фон. */
  pause: (link: ChatLink, rule: string) => boolean;
  log?: (message: string, error?: unknown) => void;
}

export function createWatchPause(deps: WatchPauseDeps): (link: ChatLink) => boolean {
  return (link) => {
    const { parentChatId, groupIndex } = link;
    if (!parentChatId || typeof groupIndex !== 'number') return false;
    // Сбой чтения настроек или сигналов не роняет конец хода: звено заводится как обычно.
    try {
      const settings = deps.settings();
      if (!settings.enabled || !settings.autoPause) return false;
      const rule = autoPauseRule(settings, groupSignalsOf(deps.signals(parentChatId, groupIndex)));
      if (!rule || deps.humanWaits(parentChatId, groupIndex)) return false;
      return deps.pause(link, rule);
    } catch (error) {
      deps.log?.('[group-watch] safe-point pause failed', error);
      return false;
    }
  };
}
