import { useSyncExternalStore } from 'react';
import type { InstallAppState, InstallPromptEvent } from './install-app.types';

/**
 * Установка панели как приложения (своё окно, значок в панели задач).
 *
 * Браузер присылает `beforeinstallprompt` ОДИН раз, вскоре после загрузки
 * страницы, — задолго до того, как человек дойдёт до настроек. Поэтому слушаем
 * его на уровне модуля, с первого импорта, и держим событие до нажатия кнопки:
 * хук внутри карточки его бы уже пропустил.
 */

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function runningAsApp(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia('(display-mode: standalone)').matches;
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Свою плашку браузера не показываем: установка — из настроек, по кнопке.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    notify();
  });
}

/** Текущее состояние установки — то же, что отдаёт хук. */
export function installAppState(): InstallAppState {
  if (installed || runningAsApp()) return 'installed';
  return deferred ? 'available' : 'unavailable';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Показать системный диалог установки. `false` — диалога нет или человек отказался. */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  // Событие одноразовое: второй вызов `prompt()` браузер отклоняет.
  deferred = null;
  notify();
  await event.prompt();
  const choice = await event.userChoice;
  return choice.outcome === 'accepted';
}

/** Можно ли сейчас установить панель, уже ли она открыта как приложение. */
export function useInstallApp(): InstallAppState {
  return useSyncExternalStore(subscribe, installAppState, () => 'unavailable');
}
