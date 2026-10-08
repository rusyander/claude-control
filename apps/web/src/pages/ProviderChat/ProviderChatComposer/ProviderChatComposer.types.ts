import type { ComposerModeState } from '@entities/Media';
import type { AgentImage } from '@agentdeck/contracts/agent-images';

export interface ProviderChatComposerProps {
  /** Пути прикреплённых файлов: CLI читает их сам, содержимое не вкладывается. */
  attachments: string[];
  onAttach: () => void;
  onClearAttachments: () => void;
  /**
   * Отправка. `false` (в том числе через промис) означает, что текст не приняли, —
   * тогда поле не чистится: описание картинки переписывают, а не набирают заново.
   */
  onSend: (text: string, images: AgentImage[]) => void | boolean | Promise<void | boolean>;
  isRunning: boolean;
  /** Идущий ход примет сообщение посреди ответа (В1) — подписи говорят об этом. */
  isSteerable?: boolean;
  /** Ни CLI, ни ключа — отправлять некуда. */
  isBlocked: boolean;
  /**
   * Режимы отправки (Т10): картинка и презентация работают и здесь. У чужого CLI
   * рабочая дорога — просьба к самому агенту (блок в ответе), но решает это
   * сервер, и состояние приходит готовым: считать доступность в двух местах
   * значит разойтись с настоящим маршрутом.
   */
  modes?: ComposerModeState;
}
