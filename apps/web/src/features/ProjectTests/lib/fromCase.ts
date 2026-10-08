import type { ProjectTestCase } from '@agentdeck/contracts';
import type { CaseDraft } from '../model/useCaseDraft.types';
import { BLANK } from '../model/useCaseDraft.constants';

/** Кейс в черновик формы. Ровно обратное `toInput`, поэтому проверяются парой. */
export function fromCase(testCase: ProjectTestCase | undefined): CaseDraft {
  if (!testCase) return BLANK;
  return {
    id: testCase.id,
    type: testCase.type ?? 'case',
    title: testCase.title,
    purpose: testCase.purpose ?? '',
    area: testCase.area ?? '',
    section: testCase.section ?? '',
    precondition: testCase.precondition ?? '',
    steps:
      testCase.steps.length > 0 ? testCase.steps.map((step) => ({ ...step })) : [{ action: '' }],
    expected: testCase.expected ?? '',
    postcondition: testCase.postcondition ?? '',
    oracle: testCase.oracle ?? '',
    priority: testCase.priority ?? 'medium',
    readiness: testCase.readiness ?? 'draft',
    duration: testCase.duration === undefined ? '' : String(testCase.duration),
    tags: (testCase.tags ?? []).join(', '),
    links: (testCase.links ?? []).map((link) => ({ ...link })),
    attributes: { ...(testCase.attributes ?? {}) },
    parameters: (testCase.parameters ?? []).map((item) => ({
      name: item.name,
      values: [...item.values],
    })),
    attachments: [...(testCase.attachments ?? [])],
    automationStatus: testCase.automation?.status ?? 'manual',
    automationFile: testCase.automation?.file ?? '',
    automationTestName: testCase.automation?.testName ?? '',
    automationExternalId: testCase.automation?.externalId ?? '',
    codePaths: (testCase.codePaths ?? []).join('\n'),
    archived: Boolean(testCase.archived),
  };
}
