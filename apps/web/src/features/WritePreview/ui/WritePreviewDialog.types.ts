import type { ProviderPreviewResponse } from '@agentdeck/contracts';

export interface WritePreviewDialogProps {
  isOpen: boolean;
  isLoading: boolean;
  preview: ProviderPreviewResponse | undefined;
  error: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}
