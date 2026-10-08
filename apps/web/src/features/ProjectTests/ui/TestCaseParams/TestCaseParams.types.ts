import type { ProjectTestLink, ProjectTestParameter } from '@agentdeck/contracts';

export interface TestCaseParamsProps {
  parameters: ProjectTestParameter[];
  onChange: (parameters: ProjectTestParameter[]) => void;
}

export interface TestCaseLinksProps {
  links: ProjectTestLink[];
  onChange: (links: ProjectTestLink[]) => void;
}
