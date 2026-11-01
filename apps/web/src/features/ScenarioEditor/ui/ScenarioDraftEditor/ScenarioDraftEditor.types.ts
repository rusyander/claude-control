import type { ReactNode } from 'react';
import type { DraftProblem, EditorDraft } from '../../model/scenarioDraft';

export interface ScenarioDraftEditorProps {
  draft: EditorDraft;
  onChange: (draft: EditorDraft) => void;
  /** `id@v`, под которым ядро запишет черновик (версия — «последняя в библиотеке + 1»). */
  versionRef: string;
  /** Суд схемы контрактов над сценарием, который уйдёт в ядро. */
  problems: DraftProblem[];
  /** Основа ветвилась: сохранение выпрямит зависимости в порядок списка. */
  isNotChain: boolean;
  /** id не меняется (правка задачи пишет новую версию того же id). */
  isIdLocked?: boolean;
  /** Идёт запрос к ядру. */
  isBusy: boolean;
  /** Кнопка записи и ответ ядра — у вызывающего. */
  footer: ReactNode;
}
