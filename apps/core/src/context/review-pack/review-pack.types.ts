import type { SentSection } from '../brief/brief.types.ts';

/** Файл диффа единицы против базы (`git diff --numstat` + тело). */
export interface PackFile {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
  /** Тело диффа; `null` — нет тела в git (новый неотслеживаемый файл, двоичный): только имя. */
  diff: string | null;
}

export interface PackRequirement {
  id: string;
  ordinal: number;
  text: string;
  verdict: string;
}

/** Сводка записи проверки: что гнали, чем кончилось, где запись. */
export interface PackRecord {
  checkId: string;
  unit: string;
  state: string;
  recordId: string | null;
}

/**
 * Вход пакета ревью. Поля разговора автора здесь нет и быть не может (03 §Context: «never the
 * author's conversation»): ревьюер судит дифф, требования и записи, а не рассказ о работе.
 */
export interface ReviewPackInput {
  unitId: string;
  baseRef: string;
  files: readonly PackFile[];
  requirements: readonly PackRequirement[];
  records: readonly PackRecord[];
  /** Предел тел диффа в байтах; сверх — список файлов и `unit_diff(file)`. */
  capBytes?: number;
  /** Значения, известные ядру секретом по имени (окружение сеанса): маска по значению (P61). */
  known?: readonly string[];
}

export interface ReviewPack {
  text: string;
  /** `inline` — тела диффа в пакете; `file-list` — список, тела по запросу `unit_diff`. */
  mode: 'inline' | 'file-list';
  sections: SentSection[];
  /** Тексты секций под маской, в порядке `sections`: повтор в той же сессии шлёт только изменённые. */
  blocks: { id: string; text: string }[];
  masked: number;
  bytes: number;
}
