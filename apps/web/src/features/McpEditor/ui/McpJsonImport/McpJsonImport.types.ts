export interface McpJsonImportProps {
  /** Импорт завершён — вызывается после создания всех серверов. */
  onDone: () => void;
}

/** Сервер из пачки, которого записать не удалось, и причина словами сервера. */
export interface ImportFailure {
  name: string;
  message: string;
}
