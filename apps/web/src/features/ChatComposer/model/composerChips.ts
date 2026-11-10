import { useSyncExternalStore } from 'react';
import type { ComposerChip } from './composerChips.types';

/**
 * Чипы ввода чата, которые приходят не файлом, а описанием: выбранный в окне сайта элемент
 * (этап 12, P174). Хранилище одно на страницу — поле ввода в чате одно; страница кладёт чип,
 * поле его показывает и даёт снять, а при отправке страница дописывает блоки чипов к сообщению.
 */
let chips: readonly ComposerChip[] = [];
const listeners = new Set<() => void>();

function emit(next: readonly ComposerChip[]): void {
  chips = next;
  for (const listener of listeners) listener();
}

/** Предел чипов: описание элемента — до 4 КБ разметки, десяток таких уже тяжёлое сообщение. */
export const COMPOSER_CHIPS_MAX = 5;

export const composerChips = {
  list: (): readonly ComposerChip[] => chips,
  /** Тот же элемент второй раз не дублируется; сверх предела уходит самый старый. */
  add(chip: ComposerChip): void {
    const rest = chips.filter((item) => item.id !== chip.id);
    emit([...rest, chip].slice(-COMPOSER_CHIPS_MAX));
  },
  remove(id: string): void {
    emit(chips.filter((item) => item.id !== id));
  },
  clear(): void {
    if (chips.length > 0) emit([]);
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Чипы для поля ввода — подписка, а не пропсы: док между страницей и полем их не несёт. */
export function useComposerChips(): readonly ComposerChip[] {
  return useSyncExternalStore(composerChips.subscribe, composerChips.list, composerChips.list);
}

/**
 * Сообщение с чипами: набранный текст, затем блок каждого чипа отдельным абзацем — агент
 * читает просьбу человека первой, а описание элемента — как приложение к ней.
 */
export function withChipBlocks(text: string, list: readonly ComposerChip[]): string {
  if (list.length === 0) return text;
  return [text.trimEnd(), ...list.map((chip) => chip.block)].join('\n\n');
}
