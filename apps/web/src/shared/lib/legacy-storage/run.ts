import { migrateBrowserStorage } from './migrateBrowserStorage';

// Модуль с побочным действием намеренно: `main.tsx` импортирует слайс ПЕРВЫМ, а
// хранилища читают ключи уже при загрузке своих модулей — вызов в теле
// `main.tsx` пришёл бы после них.
migrateBrowserStorage();
