import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { ru } from './ru';
import { en } from './en';

/**
 * Ключи разбиты на неймспейсы по разделам, но подключаются одним бандлом:
 * словарь небольшой, а ленивая загрузка ради него добавила бы мигание
 * непереведённого текста при первом открытии раздела.
 */
void i18n.use(initReactI18next).init({
  resources: {
    ru: { translation: ru },
    en: { translation: en },
  },
  lng: 'ru',
  fallbackLng: 'ru',
  interpolation: { escapeValue: false },
});

export { i18n };
