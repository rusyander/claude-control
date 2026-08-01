import type { ActionRow } from './ProviderHooks.types';

export interface ProviderHookActionEditorProps {
  action: ActionRow;
  disabled: boolean;
  onChange: (patch: Partial<ActionRow>) => void;
  onRemove: () => void;
}
