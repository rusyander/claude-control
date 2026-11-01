/** Тетрадь задачи в копии (порт `task-notebook`): путь от корня копии и прочитанный текст. */
export interface NotebookRef {
  path: string;
  /** `null` — файла нет или он не прочитался: бриф называет путь, но не тело. */
  text: string | null;
}

export interface DoneStepRef {
  title: string;
  kind: string;
  outcome: 'done' | 'failed' | 'skipped';
}

/** Состояние единицы для нового разговора (порт `cold-brief`): факты собраны ядром один раз. */
export interface HandoffInput {
  doneSteps: readonly DoneStepRef[];
  /** Изменённые файлы единицы против базы (`diffUnit`). */
  changedFiles: readonly string[];
  notebook?: NotebookRef;
}

/** Находка ревью в брифе — номер и заголовок (порт `review-findings`); тело — в файле. */
export interface FindingRef {
  id: string;
  title: string;
}
