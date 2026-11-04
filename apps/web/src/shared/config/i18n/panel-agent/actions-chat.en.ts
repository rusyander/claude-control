import type { panelActionsChatRu } from './actions-chat.ru.ts';

/** Английские названия действий над чатами (U1); ключи — по русскому модулю. */
export const panelActionsChatEn: Record<keyof typeof panelActionsChatRu, string> = {
  read_chat: 'Read a chat',
  search_chats: 'Search chat messages',
  list_waiting: 'What in the chats waits for you',
  list_chat_projects: 'Folders that have chats',
  send_chat_message: 'Write into a chat',
  stop_chat_run: 'Stop the agent in a chat',
  split_control: 'Split control',
};
