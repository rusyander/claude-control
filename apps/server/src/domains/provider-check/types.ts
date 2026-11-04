import type { ModelInfo } from '@agentdeck/contracts';
import type { OneShotResult } from '../core-ask/core-ask.types.ts';
import type { CoreRoutesReader } from './steps-core-route.ts';

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
  /**
   * Вопрос ядра «ask» названным CLI (`core-ask/one-shot.ts`); нет — шаг ассистента пропущен:
   * своего запуска CLI у проверки больше нет.
   */
  ask?: (providerId: string, prompt: string, timeoutMs: number) => Promise<OneShotResult>;
  /** Таймаут одного запуска ассистента, мс. */
  assistantTimeoutMs?: number;
  /** Маршруты ядра исполнения задач (шаг «маршрут ядра»); ядро читается через сверенную строку. */
  coreRoutes: CoreRoutesReader;
}
