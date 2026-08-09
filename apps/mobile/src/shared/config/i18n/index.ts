import { useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getLocales } from 'expo-localization';
import { ru, type Dictionary } from './ru';
import { en } from './en';

/**
 * Язык приложения. Два — русский и английский, как в панели.
 *
 * По умолчанию берётся язык телефона, а не жёсткое «русский»: приложение ставят
 * на своё устройство, и его язык — самое честное предположение. Выбранный руками
 * переживает перезапуск и живёт на телефоне: это свойство устройства, а не
 * панели, у которой свой язык на своём экране.
 *
 * Словарь отдаётся целиком объектом, а не по строковому ключу: опечатка в
 * `t.chat.blank` — ошибка типов, опечатка в `t('chat.blank')` — пустое место на
 * экране, замеченное пользователем раньше, чем мной.
 */

export type Language = 'ru' | 'en';

const KEY = 'language.v1';
const DICTIONARIES: Record<Language, Dictionary> = { ru, en };

let language: Language = deviceLanguage();
const listeners = new Set<() => void>();

function deviceLanguage(): Language {
  try {
    const code = getLocales()[0]?.languageCode ?? 'ru';
    return code === 'ru' ? 'ru' : 'en';
  } catch {
    return 'ru';
  }
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): Language {
  return language;
}

export async function loadLanguage(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(KEY);
    if (saved === 'ru' || saved === 'en') {
      language = saved;
      emit();
    }
  } catch {
    // Настройка не прочиталась — остаёмся на языке телефона.
  }
}

export function setLanguage(next: Language): void {
  language = next;
  void AsyncStorage.setItem(KEY, next);
  emit();
}

/** Словарь вне React: для потока прогона, уведомлений и ошибок транспорта. */
export function dict(): Dictionary {
  return DICTIONARIES[language];
}

export function useT(): Dictionary {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  return DICTIONARIES[language];
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type { Dictionary };
