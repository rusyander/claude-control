import type { ProjectTestEnvironment } from '@agentdeck/contracts';

export interface TestSecretsModalProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Каталог проекта: доступы адресуются им же, чем и вся библиотека. */
  path: string | undefined;
  /** Окружение, доступы которого правят. */
  environment: ProjectTestEnvironment;
}
