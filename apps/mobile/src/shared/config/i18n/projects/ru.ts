/**
 * Вкладка «Проекты» и экран проекта. Отдельным модулем, как главная: словарь
 * общий, а правят его одновременно несколько разделов.
 */

/** 1 чат, 2 чата, 5 чатов (11–14 — всегда третья форма). */
function form(count: number, one: string, few: string, many: string): string {
  const tail = count % 10;
  const tens = count % 100;
  if (tail === 1 && tens !== 11) return one;
  if (tail >= 2 && tail <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

export const projectsRu = {
  tabProjects: 'Проекты',
  tabFolders: 'Папки',
  search: 'Найти проект',
  current: 'открыт',
  chats: (count: number) => `${count} ${form(count, 'чат', 'чата', 'чатов')}`,
  noChats: 'Чатов ещё не было',
  continueChat: 'Продолжить',
  newChat: 'Новый чат',
  newChatIn: (name: string) => `Новый чат в ${name}`,
  openProject: (name: string) => `Проект ${name}`,
  running: (count: number) => `работает: ${count}`,
  waiting: (count: number) => `ждёт: ${count}`,
  others: (count: number) => `Из истории чатов · ${count}`,
  othersHint: 'Здесь запускался агент, но в проектах панели этих папок нет.',
  addToProjects: 'В проекты',
  inProjects: 'В проектах',
  emptyTitle: 'Проектов в панели нет',
  emptyText: 'Добавьте папку на вкладке «Папки» или в разделе «Проекты» на компьютере.',
  nothingFound: 'Ничего не нашлось',
  gone: 'папки больше нет',
  copy: (name: string) => `копия ${name}`,
  // Экран проекта
  tabChats: 'Чаты',
  tabGit: 'Git',
  tabCopies: 'Копии',
  code: 'Код',
  tests: 'Тесты',
  chatsEmpty: 'В этом проекте ещё не разговаривали. Начните первый чат.',
  showAll: (count: number) => `Показать все · ${count}`,
  // Папки
  disks: 'Диски',
  toDisks: 'к дискам',
  newChatHere: 'Новый чат здесь',
  addHere: 'Добавить в проекты',
};
