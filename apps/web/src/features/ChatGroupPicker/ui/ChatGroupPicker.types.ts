import type {
  ChatGroupChoice,
  ChatGroupSettingsView,
} from '@agentdeck/contracts/chat-group-settings';

export interface ChatGroupPickerProps {
  /** Действующий вид настроек чата (свои + унаследованные). */
  view: ChatGroupSettingsView;
  /** Основная копия проекта: проектные группы — только её. */
  scopePath: string | undefined;
  /** Подсказка под полем: «из родителя: …» или обычное пояснение. */
  hint: string;
  onChange: (choice: ChatGroupChoice) => void;
}
