import type { ProjectTestStep, ProjectTestCaseInput } from '@agentdeck/contracts';
import type { CaseDraft } from '../model/useCaseDraft.types';

/** Пустой шаг выбрасывается: пустая строка в файле — это мусор, а не шаг. */
export function trimStep(step: ProjectTestStep): ProjectTestStep | undefined {
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
    // Пустое поле уходит нулём — это «очисти»: без поля сервер оставил бы на
    // диске прежнее число, и стёртую оценку было бы не убрать.
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
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
    codePaths: draft.codePaths
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    archived: draft.archived,
  };
}
