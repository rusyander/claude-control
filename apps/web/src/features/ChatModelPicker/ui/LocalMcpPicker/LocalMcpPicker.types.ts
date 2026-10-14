export interface LocalMcpPickerProps {
  /** Каталог проекта: по нему читаются серверы и запоминается выбор. */
  project: string;
  /** Что уже взято (из плана прогона) — подпись кнопки без загрузки списка. */
  picked: string[];
}
