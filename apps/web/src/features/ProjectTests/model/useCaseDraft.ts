import { useEffect, useState } from 'react';
import type { ProjectTestCase, ProjectTestCaseInput } from '@agentdeck/contracts';
import type { CaseDraft } from './useCaseDraft.types';
import { BLANK } from './useCaseDraft.constants';
import { fromCase } from '../lib/fromCase';
import { toInput } from '../lib/toInput';

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
