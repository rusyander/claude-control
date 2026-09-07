import type { CascadeStage } from '@agentdeck/contracts/model-cascade';

/**
 * Группа разделения глазами родителя: где она сейчас и чем ведётся.
 *
 * Одна группа — до трёх разговоров (работа, ревью, правки), и все они живут в
 * одной копии. Строка сводки описывает ГРУППУ, а не разговор: `chatId` — это
 * последнее её звено, то самое, которое человек и хочет открыть.
 */
export interface ChildStageGroup {
  chatId: string;
  title: string;
  branch?: string;
  /** Пройденные звенья по порядку; последнее — нынешнее состояние группы. */
  stages: CascadeStage[];
  /** Чем ведётся последнее звено: из транскрипта, иначе из назначения панели. */
  model?: string;
  isRunning: boolean;
}

export interface ChildStagesProps {
  groups: ChildStageGroup[];
  /** Открыть звено в этом же окне — вкладка копии для этого не нужна. */
  onOpen: (chatId: string) => void;
}
