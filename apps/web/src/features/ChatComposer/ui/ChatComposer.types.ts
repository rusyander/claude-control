/** Отсеянные при вложении — их называют человеку, каждый со своей причиной. */
export interface AttachRejection {
  /** Тип, который панель не передаёт: только имена. */
  unsupported: string[];
  /** Крупнее предела: имя и настоящий размер — «больше 20 МБ» без него не сверить. */
  tooLarge: { name: string; size: number }[];
}

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
   * Файлы, которые не приложились: тип, который панель не передаёт, или размер
   * больше предела. Сказать о них обязана страница — тем же семейством
   * сообщений, что и отказ при отправке, а не вторым механизмом рядом.
   */
  onRejectFiles?: (rejection: AttachRejection) => void;
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
