export interface TestsRunDiffProps {
  projectPath: string | undefined;
  /** Прогон, с которым сравнивают; вторую сторону выбирает сервер. */
  runId: string;
  /** Раскрыт ли блок сразу: в отчёте — да, в истории — по кнопке. */
  isOpenByDefault?: boolean;
}
