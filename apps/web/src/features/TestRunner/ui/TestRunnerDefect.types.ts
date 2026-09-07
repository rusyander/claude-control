export interface TestRunnerDefectProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  /** Кейс, по которому заводится дефект, и прогон, из которого взят провал. */
  groupId: string;
  caseId: string;
  runId?: string;
}
