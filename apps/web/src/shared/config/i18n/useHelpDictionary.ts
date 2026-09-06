import { useEffect, useReducer, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toLanguage } from './instance';
import { hasHelp, loadHelp } from './help-loader';

/**
 * Справка текущего языка загружена и её можно рисовать. Первый заход
 * обеспечивает лоадер маршрута /help; хук нужен для смены языка на открытой
 * странице: дотягивает второй словарь и перерисовывает, а до его прихода
 * страница показывает русский текст (fallbackLng), не ключи. Нет вообще
 * никакого словаря и загрузка упала — бросаем ошибку в границу маршрута:
 * там есть «Попробовать снова».
 */
export function useHelpDictionary(): boolean {
  const { i18n } = useTranslation();
  const language = toLanguage(i18n.language);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    if (hasHelp(language)) return;
    let alive = true;
    loadHelp(language).then(
      () => alive && rerender(),
      (error: unknown) => alive && setFailure(error),
    );
    return () => {
      alive = false;
    };
  }, [language]);

  const ready = hasHelp(language) || hasHelp('ru');
  if (!ready && failure) throw failure;
  return ready;
}
