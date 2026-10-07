import type {
  ProviderChatDetail,
  ProviderEditsWhenOff,
  ProviderRunnerInfo,
} from '@agentdeck/contracts';

export interface ProviderChatHeaderProps {
  chat?: ProviderChatDetail;
  providerName: string;
  /**
   * Идентификатор провайдера разговора: по нему спрашивается, чем прогон пойдёт
   * через контур (Т6). Пусто — провайдер ещё не приехал, и о контуре шапка
   * ничего не утверждает.
   */
  providerId: string;
  runner?: ProviderRunnerInfo;
  isRunning: boolean;
  onRename: (title: string) => void;
  onPickWorkdir: () => void;
  onDelete: () => void;
  onStop: () => void;
  /**
   * Перезапустить разговор в чистом виде (Т7). Сессии у чужого CLI нет, поэтому
   * это новый разговор с контрольной точкой; пусто — перезапускать нечего.
   */
  onRestart?: () => void;
  isRestarting?: boolean;
  /**
   * «Разрешить правки» разговора. Нет обработчика — до этого CLI переключатель
   * не доходит ни флагом, ни живым сервером, и вместо него подсказка: решают
   * настройки самого CLI.
   */
  allowEdits?: boolean;
  onAllowEditsChange?: (next: boolean) => void;
  /** Смысл выключенного переключателя: вопрос карточкой или закрытая запись. */
  editsWhenOff?: ProviderEditsWhenOff;
}
