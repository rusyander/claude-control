import type { GroupMembersView, PathAnchor } from '@agentdeck/contracts';

/**
 * Вид строки для метки в конструкторе — ровно шесть слов, которые человек
 * различает: наш скилл, чужой скилл, промпт, хук, правило, утилита (и стадия у
 * конвейера). Скилл проекта — наш: он в файлах того же проекта; скилл плагина —
 * чужой: панель его не пишет и не правит.
 */
export type RowType =
  'stage' | 'our-skill' | 'foreign-skill' | 'prompt' | 'hook' | 'rule' | 'script';

export interface WordsSource {
  language: string;
  view: GroupMembersView | undefined;
  stageTitle: (stage: PathAnchor) => string;
  stageHint: (stage: PathAnchor) => string;
  wholeTitle: (skillId: string) => string;
  /** Название шага скилла, пока его описание готовится: «Шаг 13 скилла». */
  pendingStepTitle: (number: number) => string;
  /** Строка шага скилла, который описать не вышло: «не описан — оригинал в окне шага». */
  notDescribedLine: string;
  /** Раздел шага в тексте скилла, если текст у панели есть. */
  sectionText: (skillId: string, index: number) => string | undefined;
}
