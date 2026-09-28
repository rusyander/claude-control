export interface ChatGroupSettingsMenuProps {
  /** Ключ разговора во вкладке — `new-…` до первого хода. */
  chatId: string;
  /** Настоящий ключ разговора, когда прогон его уже назвал. */
  sessionId?: string;
  /** Каталог разговора: проектные группы показываются только своего проекта. */
  projectPath?: string;
}
