import { useSyncExternalStore } from 'react';
import {
  getChatPrefs,
  subscribeChatPrefs,
  setAllowEdits,
  setSound,
  setSoundVolume,
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
    soundVolume: prefs.soundVolume,
    setSoundVolume,
    autoApprove: prefs.autoApprove,
    setAutoApprove,
  };
}
