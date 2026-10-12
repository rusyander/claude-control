import { useEffect, useState, useSyncExternalStore } from 'react';
import { loadDraft } from './draft-storage';
import { saveDraft } from './saveDraft';
import type { DraftBox } from './useDraftBox.types';

interface KeyedDraftBox extends DraftBox {
  /** Сменился контекст — показать его черновик; прежний уже лежит на диске. */
  switchKey: (key: string | undefined) => void;
}

/**
 * Хранилище черновика с ключом контекста — та же логика, что у `useDraft`, но
 * текст живёт не в состоянии компонента. Иначе каждая буква перерисовывала бы
 * того, кто черновик держит: у чата это вся страница — список разговоров,
 * шапка и лента целиком, — и люди видели мигание, пока печатают.
 */
export function createDraftBox(initialKey: string | undefined): KeyedDraftBox {
  let key = initialKey;
  let value = key ? loadDraft(key) : '';
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((listener) => listener());
  return {
    get: () => value,
    set: (next) => {
      if (next === value) return;
      value = next;
      if (key) saveDraft(key, next);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchKey: (next) => {
      if (next === key) return;
      key = next;
      value = next ? loadDraft(next) : '';
      notify();
    },
  };
}

/**
 * Черновик поля с ключом контекста; ящик один на всю жизнь компонента, поэтому
 * его можно отдавать вниз и в зависимости без лишних перерисовок. Пустой ключ
 * отключает запись на диск.
 */
export function useDraftBox(key: string | undefined): DraftBox {
  const [box] = useState(() => createDraftBox(key));
  useEffect(() => box.switchKey(key), [box, key]);
  return box;
}

/** Текст черновика с подпиской: перерисовывается только вызвавший компонент. */
export function useDraftValue(box: DraftBox): string {
  return useSyncExternalStore(box.subscribe, box.get, box.get);
}
