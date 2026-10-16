import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Где мы сейчас: каталог проекта и открытый разговор.
 *
 * Это единственное состояние интерфейса, которое переживает перезапуск, — и
 * хранится оно на телефоне, а не на сервере, намеренно: «какой проект открыт у
 * меня в руке» не свойство панели, а свойство этого устройства.
 *
 * У каждого спаренного компьютера своё место: проекты и разговоры одной машины
 * на другой не существуют, и открытый там чат здесь был бы пустым экраном.
 */

const LEGACY_KEY = 'workspace.v1';
const keyFor = (panelId: string): string => (panelId ? `${LEGACY_KEY}.${panelId}` : LEGACY_KEY);
let key = LEGACY_KEY;

export interface Workspace {
  /** Каталог проекта; пусто — домашний чат (без привязки к проекту). */
  projectPath: string;
  /** Открытый разговор; `new-*` — ещё не начатый. */
  chatId: string;
  ready: boolean;
  /** Чьё это место — id компьютера из списка спаренных. */
  panelId: string;
}

let state: Workspace = { projectPath: '', chatId: '', ready: false, panelId: '' };
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

/**
 * Место компьютера `panelId`. Место из версий с одной панелью (без суффикса)
 * достаётся первому компьютеру, который его спросит, — это тот, с которым
 * телефон и был спарен.
 */
export async function loadWorkspace(panelId = ''): Promise<void> {
  key = keyFor(panelId);
  try {
    let raw = await AsyncStorage.getItem(key);
    if (raw === null && panelId) {
      raw = await AsyncStorage.getItem(LEGACY_KEY);
      if (raw !== null) {
        await AsyncStorage.setItem(key, raw);
        await AsyncStorage.removeItem(LEGACY_KEY);
      }
    }
    const parsed = raw ? (JSON.parse(raw) as Partial<Workspace>) : {};
    state = {
      projectPath: parsed.projectPath ?? '',
      chatId: parsed.chatId ?? '',
      ready: true,
      panelId,
    };
  } catch {
    state = { projectPath: '', chatId: '', ready: true, panelId };
  }
  emit();
}

/** Компьютер забыт — его место тоже. */
export function forgetWorkspace(panelId: string): Promise<void> {
  return AsyncStorage.removeItem(keyFor(panelId));
}

function persist(): void {
  void AsyncStorage.setItem(
    key,
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
