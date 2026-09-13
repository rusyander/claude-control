export interface AttachedFile {
  name: string;
  sizeBytes: number;
  /** Содержимое в base64 — сервер положит файл в папку чата. */
  base64: string;
}

/**
 * Режимы отправки живут в сущности «Медиа» (Т10): их состояние считает один общий
 * хук, нужный и чату Claude, и чату чужого CLI, а фича не вправе импортировать
 * другую фичу. Здесь — только повторный вывоз имён, чтобы адреса импортов в
 * страницах не менялись.
 */
import type { ComposerModeState } from '@entities/Media';

export type { ComposerMode, ComposerModeState } from '@entities/Media';

export interface ChatComposerProps {
  value: string;
  onChange: (value: string) => void;
  /**
   * Отправка. `false` (в том числе через промис) означает, что сообщение не
   * приняли, — вложения тогда остаются в поле: иначе отказ сервера заставлял бы
   * прикладывать файлы заново.
   */
  onSend: (files: AttachedFile[]) => void | boolean | Promise<void | boolean>;
  onStop: () => void;
  /**
   * Файлы, которые не приложились (сейчас — крупнее предела). Сказать о них
   * обязана страница: отказ идёт тем же путём, что и отказ по типу файла, —
   * одним сообщением, а не вторым механизмом рядом.
   */
  onRejectFiles?: (names: string[]) => void;
  isRunning: boolean;
  /**
   * Попросить агента разделить задачи по чатам. Пусто — кнопки нет: вне проекта
   * делить нечего, копию репозитория заводить не из чего.
   */
  onSplitTasks?: () => void;
  /**
   * Попросить агента закрыть этап и подготовить продолжение в чистой сессии.
   * Пусто — кнопки нет: вне проекта продолжать некуда, каталог новой сессии
   * неизвестен.
   */
  onHandoff?: () => void;
  /**
   * Режимы отправки (Т9). Пусто — меню нет вовсе: у чужого CLI и в местах, где
   * рисовать некому, лишний пункт только обещал бы то, чего не будет.
   */
  modes?: ComposerModeState;
}

export interface ChatModeMenuProps {
  state: ComposerModeState;
  /** Меню заперто целиком, пока идёт прогон или рисование. */
  disabled: boolean;
}
