import type { ClaudeLocation, ProviderDetectResponse } from '@claude-control/contracts';

export interface LocationStepProps {
  location: ClaudeLocation;
  /** Применить путь, введённый руками. Тот же обработчик получает путь из окна выбора папки. */
  onApply: (path: string) => void;
  isApplying: boolean;
  /** Почему последняя попытка не принята — текст сервера или ошибка запроса. */
  applyProblem?: string;
  onPickFolder: () => void;
  /** Вернуться к автоопределению — кнопка есть только у каталога, заданного вручную. */
  onReset: () => void;
  isResetting: boolean;
}

export interface ProvidersStepProps {
  detect: ProviderDetectResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  activeProviderId: string;
  onChoose: (providerId: string) => void;
  isChoosing: boolean;
}

export interface AccessStepProps {
  /** Открыть форму ручного доступа — окно живёт в оболочке мастера, поверх него. */
  onSetManually: () => void;
}
