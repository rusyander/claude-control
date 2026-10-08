/** Ответ записи/удаления: путь резервной копии называет тост. */
export interface ScriptWriteResult {
  ok: boolean;
  backupPath?: string;
  needsRestart?: boolean;
}
