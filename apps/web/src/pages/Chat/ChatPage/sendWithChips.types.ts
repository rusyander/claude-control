import type { ComposerChip } from '@features/ChatComposer';

/** Хранилище чипов поля ввода — подаётся снаружи, чтобы отправку проверять без модуля-синглтона. */
export interface ChipSendDeps {
  list: () => readonly ComposerChip[];
  clear: () => void;
}
