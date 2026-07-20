import type { SandboxModalProps } from './SandboxModal.types';

export type SandboxButtonProps = Omit<SandboxModalProps, 'isOpen' | 'onOpenChange'> & {
  size?: 'sm' | 'md';
};
