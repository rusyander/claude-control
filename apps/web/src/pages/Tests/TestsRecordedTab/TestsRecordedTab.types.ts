import type {
  ProjectTestEnvironment,
  ProjectTestGroup,
  RecordedCaseView,
  RecordedReplayState,
} from '@agentdeck/contracts';

export interface TestsRecordedTabProps {
  projectPath: string | undefined;
  environments: ProjectTestEnvironment[];
  groups: ProjectTestGroup[];
}

export interface RecordedCaseRowProps {
  item: RecordedCaseView;
}

export interface RecordedMismatchCardProps {
  projectPath: string | undefined;
  replay: RecordedReplayState;
}

export interface RecordWalkModalProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  projectPath: string | undefined;
  environments: ProjectTestEnvironment[];
  groups: ProjectTestGroup[];
}
