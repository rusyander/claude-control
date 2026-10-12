import type { TFunction } from 'i18next';
import type { BackendGuardSettings } from '@entities/BackendGuard';
import { toErrorMessage } from '@shared/api/toErrorMessage';
import { dbErrorCode } from './dbError';

/**
 * Отказ маршрутов защиты бэкенда → текст окна. Сервер шлёт свой `code` без
 * `messageCode` — тексты здесь, на двух языках.
 */
export function guardErrorText(error: unknown, t: TFunction): string {
  switch (dbErrorCode(error)) {
    case 'guard-project-unregistered':
      return t('environment.guard.errors.unregistered');
    case 'guard-not-installed':
      return t('environment.guard.errors.notInstalled');
    default:
      return t('environment.guard.errors.generic', { message: toErrorMessage(error) });
  }
}

/** Строки поля «Метки прода» → список: без пустых, без повторов, без пробелов по краям. */
export function parseMarkers(text: string): string[] {
  return [
    ...new Set(
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

/** Метки короче трёх знаков сервер не примет — окно называет их до отправки. */
export const shortMarkers = (markers: readonly string[]): string[] =>
  markers.filter((marker) => marker.length < 3);

/** Отпечаток настроек: порядок выключенных правил не важен, порядок меток — важен (так их видит человек). */
export const settingsKey = (settings: BackendGuardSettings): string =>
  `${settings.prodMarkers.join('\n')}|${[...settings.disabled].sort().join(',')}`;
