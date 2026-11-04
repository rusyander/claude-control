import type { ChatCli } from '../../model/coreChat.types';

export interface CoreChatStartProps {
  /** Задача чата создана и запущена: страница открывает её по номеру. */
  onStarted: (taskId: string) => void;
  /** Папка, с которой форма начинает (переход из чата проекта); нет — пусто. */
  initialProject?: string;
  /** CLI, с которого форма начинает (переход из чата этого CLI); нет — Claude. */
  initialCli?: ChatCli;
  /**
   * Id разговора CLI, который чат продолжает («Продолжить через ядро» из чата панели): CLI
   * закреплён — разговор продолжает только тот CLI, чей он.
   */
  resume?: string;
}
