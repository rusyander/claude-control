export interface TestCaseResultsProps {
  projectPath: string | undefined;
  groupId: string;
  caseId: string;
  /** Подпись последнего прогона агента (`TestCaseEditorProps.runStamp`). */
  runStamp?: string;
}
