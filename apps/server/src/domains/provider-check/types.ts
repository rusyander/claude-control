import type { ModelInfo } from '@claude-control/contracts';
import type { runAssistant } from '../assistant-runner.ts';

/** Что нужно проверке от окружения (всё подменяемо в тестах). */
export interface ProviderCheckDeps {
  appDataDir: string;
  /** Пользовательский каталог конфигурации (его уважает только Claude). */
  claudeDirOverride?: string;
  /** Запускать ли настоящий вызов ассистента. */
  withAssistant: boolean;
  /** Каталог моделей из кэша — чтобы ассистент не ходил в сеть за именем модели. */
  models?: ModelInfo[];
  now?: () => Date;
  detectCli?: (command: string) => boolean;
  exists?: (path: string) => boolean;
  runAssistantImpl?: typeof runAssistant;
  /** Таймаут одного запуска ассистента, мс. */
  assistantTimeoutMs?: number;
}
