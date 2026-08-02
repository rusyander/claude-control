export interface ProviderChatComposerProps {
  /** Пути прикреплённых файлов: CLI читает их сам, содержимое не вкладывается. */
  attachments: string[];
  onAttach: () => void;
  onClearAttachments: () => void;
  onSend: (text: string) => void;
  isRunning: boolean;
  /** Ни CLI, ни ключа — отправлять некуда. */
  isBlocked: boolean;
}
