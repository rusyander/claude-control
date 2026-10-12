import type { ComposeAction, ComposeService } from '@entities/Compose';

export interface ComposeServicesProps {
  projectPath: string;
  /** Окно открыто — только тогда стек опрашивается. */
  isOpen: boolean;
}

export interface ComposeServiceRowProps {
  service: ComposeService;
  /** Над стеком идёт действие — кнопки строки погашены. */
  isBusy: boolean;
  onAction: (action: ComposeAction, service: string) => void;
}
