import type { ProjectTestCase, ProjectTestGroup } from '@agentdeck/contracts';

/** Все кейсы всех групп с пометкой, откуда каждый, — основа общего списка. */
export interface CaseWithGroup {
  groupId: string;
  groupTitle: string;
  testCase: ProjectTestCase;
}

export function allCases(groups: ProjectTestGroup[], groupId?: string): CaseWithGroup[] {
  return groups
    .filter((group) => !groupId || group.id === groupId)
    .flatMap((group) =>
      group.cases.map((testCase) => ({
        groupId: group.id,
        groupTitle: group.title,
        testCase,
      })),
    );
}
