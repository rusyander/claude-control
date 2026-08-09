import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Где мы сейчас: каталог проекта и открытый разговор.
 *
 * Это единственное состояние интерфейса, которое переживает перезапуск, — и
 * хранится оно на телефоне, а не на сервере, намеренно: «какой проект открыт у
 * меня в руке» не свойство панели, а свойство этого устройства.
 */

const KEY = 'workspace.v1';

export interface Workspace {
  /** Каталог проекта; пусто — домашний чат (без привязки к проекту). */
  projectPath: string;
  /** Открытый разговор; `new-*` — ещё не начатый. */
  chatId: string;
  ready: boolean;
}

let state: Workspace = { projectPath: '', chatId: '', ready: false };
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Workspace {
  return state;
}

export async function loadWorkspace(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<Workspace>) : {};
    state = {
      projectPath: parsed.projectPath ?? '',
      chatId: parsed.chatId ?? '',
      ready: true,
    };
  } catch {
    state = { projectPath: '', chatId: '', ready: true };
  }
  emit();
}

function persist(): void {
  void AsyncStorage.setItem(
    KEY,
    JSON.stringify({ projectPath: state.projectPath, chatId: state.chatId }),
  );
}

/** Новый разговор в этом проекте: id временный, настоящий придёт от сервера. */
export function newChatId(): string {
  return `new-${Date.now()}`;
}

export function openProject(projectPath: string): void {
  state = { ...state, projectPath, chatId: newChatId() };
  persist();
  emit();
}

export function openChat(chatId: string, projectPath?: string): void {
  state = { ...state, chatId, projectPath: projectPath ?? state.projectPath };
  persist();
  emit();
}

export function useWorkspace(): Workspace {
  const value = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (!value.ready) void loadWorkspace();
  }, [value.ready]);
  return value;
}

export function currentWorkspace(): Workspace {
  return state;
}
