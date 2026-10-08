import type { HookDraft } from '../../model/useQuickStep';

export interface HookStepFormProps {
  isSaving: boolean;
  /** Причина отказа сервера словами; пусто — отказа не было. */
  failure?: string;
  onCreate: (hook: HookDraft) => void;
}
