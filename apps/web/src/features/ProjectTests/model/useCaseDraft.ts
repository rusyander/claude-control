import { useEffect, useState } from 'react';
import type {
  ProjectTestAutomationStatus,
  ProjectTestCase,
  ProjectTestCaseInput,
  ProjectTestKind,
  ProjectTestLink,
  ProjectTestParameter,
  ProjectTestPriority,
  ProjectTestReadiness,
  ProjectTestStep,
} from '@agentdeck/contracts';

/**
 * Черновик кейса в форме.
 *
 * Форма правит СВОЮ копию, а не кейс из списка: список во время правки живёт
 * своей жизнью — его перечитывает опрос прогона, — и связывать поля напрямую с
 * ним значит терять набранное на каждом ответе сервера.
 *
 * Списочные поля (теги) держатся строкой ровно потому, что человек их так и
 * набирает: через запятую, одним движением. Разбор — на выходе, в `toInput`.
 */
export interface CaseDraft {
  id?: string;
  type: ProjectTestKind;
  title: string;
  purpose: string;
  area: string;
  section: string;
  precondition: string;
  steps: ProjectTestStep[];
  expected: string;
  postcondition: string;
  oracle: string;
  priority: ProjectTestPriority;
  readiness: ProjectTestReadiness;
  /** Минуты строкой: пустое поле — «не оценивали», а не ноль. */
  duration: string;
  tags: string;
  links: ProjectTestLink[];
  attributes: Record<string, string>;
  parameters: ProjectTestParameter[];
  attachments: string[];
  automationStatus: ProjectTestAutomationStatus;
  automationFile: string;
  automationTestName: string;
  automationExternalId: string;
  archived: boolean;
}

const BLANK: CaseDraft = {
  type: 'case',
  title: '',
  purpose: '',
  area: '',
  section: '',
  precondition: '',
  steps: [{ action: '' }],
  expected: '',
  postcondition: '',
  oracle: '',
  priority: 'medium',
  readiness: 'draft',
  duration: '',
  tags: '',
  links: [],
  attributes: {},
  parameters: [],
  attachments: [],
  automationStatus: 'manual',
  automationFile: '',
  automationTestName: '',
  automationExternalId: '',
  archived: false,
};

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
    archived: Boolean(testCase.archived),
  };
}

export interface CaseDraftState {
  draft: CaseDraft;
  patch: (part: Partial<CaseDraft>) => void;
  toInput: () => ProjectTestCaseInput;
}

export function useCaseDraft(
  testCase: ProjectTestCase | undefined,
  isOpen: boolean,
): CaseDraftState {
  const [draft, setDraft] = useState<CaseDraft>(BLANK);

  // Поля наполняются при ОТКРЫТИИ: пока форма закрыта, в ней остаётся прошлый
  // кейс, и подставлять новый в закрытую форму незачем.
  useEffect(() => {
    if (isOpen) setDraft(fromCase(testCase));
  }, [isOpen, testCase]);

  return {
    draft,
    patch: (part) => setDraft((current) => ({ ...current, ...part })),
    toInput: () => toInput(draft),
  };
}

/**
 * Черновик в то, что понимает сервер.
 *
 * Чек-лист отдаётся без ожиданий, условий и оракула намеренно: в семантике
 * Test IT чек-лист — это список «сделано/не сделано», и оставленные от прежнего
 * типа поля висели бы в файле мёртвым грузом, сбивая и агента, и человека.
 */
export function toInput(draft: CaseDraft): ProjectTestCaseInput {
  const isChecklist = draft.type === 'checklist';
  const steps = draft.steps
    .map((step) => trimStep(step))
    .filter((step): step is ProjectTestStep => step !== undefined);

  const duration = Number.parseInt(draft.duration, 10);

  return {
    ...(draft.id ? { id: draft.id } : {}),
    type: draft.type,
    title: draft.title.trim(),
    purpose: draft.purpose.trim(),
    area: draft.area.trim(),
    section: draft.section.trim(),
    precondition: isChecklist ? '' : draft.precondition.trim(),
    steps,
    expected: isChecklist ? '' : draft.expected.trim(),
    postcondition: isChecklist ? '' : draft.postcondition.trim(),
    oracle: isChecklist ? '' : draft.oracle.trim(),
    priority: draft.priority,
    readiness: draft.readiness,
    ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
    tags: draft.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    links: draft.links.filter((link) => link.url.trim()),
    attributes: draft.attributes,
    parameters: draft.parameters.filter((item) => item.name.trim() && item.values.length > 0),
    attachments: draft.attachments,
    automation: {
      status: draft.automationStatus,
      file: draft.automationFile.trim(),
      testName: draft.automationTestName.trim(),
      externalId: draft.automationExternalId.trim(),
    },
    archived: draft.archived,
  };
}

/** Пустой шаг выбрасывается: пустая строка в файле — это мусор, а не шаг. */
function trimStep(step: ProjectTestStep): ProjectTestStep | undefined {
  const action = step.action.trim();
  const ref = step.ref?.trim();
  if (!action && !ref) return undefined;
  return {
    action,
    ...(step.expected?.trim() ? { expected: step.expected.trim() } : {}),
    ...(step.data?.trim() ? { data: step.data.trim() } : {}),
    ...(ref ? { ref } : {}),
  };
}
