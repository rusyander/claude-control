export type ReadableStorage = Pick<Storage, 'getItem'>;

export interface WindowMemory {
  conversationId: string;
  /** Ход шёл, когда вкладку оставили: перезагрузка его оборвала. */
  turnOpen: boolean;
}

export type WritableStorage = Pick<Storage, 'setItem' | 'removeItem'>;
