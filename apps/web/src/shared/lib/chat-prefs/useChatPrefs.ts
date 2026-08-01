import { useSyncExternalStore } from 'react';
import {
  getChatPrefs,
  subscribeChatPrefs,
  setAllowEdits,
  setSound,
  setAutoApprove,
} from './chatPrefsStore';

/** Настройки чата (localStorage): правки, звук, автоподтверждение прав. */
export function useChatPrefs() {
  const prefs = useSyncExternalStore(subscribeChatPrefs, getChatPrefs, getChatPrefs);
  return {
    allowEdits: prefs.allowEdits,
    setAllowEdits,
    sound: prefs.sound,
    setSound,
    autoApprove: prefs.autoApprove,
    setAutoApprove,
  };
}
