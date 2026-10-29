/** Хранилище записей проверок (04:33, D§3.4): запись один раз, подпись, сжатый вывод. */
export { absentRecordDraft } from './absent.ts';
export { createRecordStore, LOG_CAP, storeRoot } from './store.ts';
export { loadVerifyKey, VERIFY_KEY_FILE } from './verify-key.ts';
export { recordSchema, RECORD_ID } from './schema.ts';
export type {
  KeyScan,
  RecordDraft,
  RecordStore,
  RecordStoreOptions,
  SkippedRecord,
  StoreIo,
} from './store.types.ts';
