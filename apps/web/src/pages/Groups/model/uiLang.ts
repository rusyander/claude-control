/** Язык интерфейса в том виде, в каком его знает сервер. */
export function uiLang(language: string): 'ru' | 'en' {
  return language.startsWith('en') ? 'en' : 'ru';
}
