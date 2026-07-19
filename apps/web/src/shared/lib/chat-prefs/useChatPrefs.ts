import { useSyncExternalStore } from 'react';
import { getChatPrefs, subscribeChatPrefs, setAllowEdits, setSound } from './chatPrefsStore';

/** Настройки чата (localStorage): тумблер правок, звук уведомлений. */
export function useChatPrefs() {
  const prefs = useSyncExternalStore(subscribeChatPrefs, getChatPrefs, getChatPrefs);
  return { allowEdits: prefs.allowEdits, setAllowEdits, sound: prefs.sound, setSound };
}
