/** Один снимок файла: копия на диске плюс разобранное время. */
export interface Snapshot {
  name: string;
  path: string;
  at: string;
}

/** Метка «против чего дифф» — переносим её и в ленту, и в полный дифф. */
export type BaseLabel = 'previous' | 'current' | 'initial';

/** Что взято базой сравнения: путь (undefined — базы нет) и метка. */
export interface DiffBase {
  basePath?: string;
  label: BaseLabel;
}

/** Результат выборочного отката ханка. Форма — как у restoreBackup. */
export interface RevertHunkResult {
  ok: boolean;
  restoredTo?: string;
  backupPath?: string;
  error?: string;
  /** Копии с таким именем нет — маршрут отвечает 404, как `GET /history/diff`, а не 400. */
  notFound?: boolean;
}
