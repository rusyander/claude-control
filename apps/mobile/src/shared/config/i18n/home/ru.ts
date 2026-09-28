/**
 * Главный экран: «Проекты и чаты» и «Вопросы». Отдельным модулем, как тексты
 * сервера: словарь общий, а правят его одновременно несколько разделов.
 */

/** 1 вопрос, 2 вопроса, 5 вопросов (11–14 — всегда третья форма). */
function form(count: number, one: string, few: string, many: string): string {
  const tail = count % 10;
  const tens = count % 100;
  if (tail === 1 && tens !== 11) return one;
  if (tail >= 2 && tail <= 4 && (tens < 12 || tens > 14)) return few;
  return many;
}

export const homeRu = {
  tabChats: 'Проекты и чаты',
  // Нижняя вкладка сохраняет своё имя: читалка экрана иначе слышит одно число.
  homeTabA11y: (count: number) => `Главная, ждут ответа: ${count}`,
  tabQuestions: 'Вопросы',
  tabQuestionsA11y: (count: number) =>
    count > 0 ? `Вопросы: ждут ответа ${count}` : 'Вопросы: ничего не ждёт',
  newChat: 'Новый чат',
  allChats: 'Все разговоры',
  failed: 'Панель не ответила — показано последнее, что пришло',
  failedEmpty: 'Панель не ответила. Потяните вниз, чтобы спросить ещё раз.',
  retry: 'Повторить',
  back: 'Назад',
  status: { running: 'работает', waiting: 'ждёт вас', idle: 'молчит' },
  groupCounts: (waiting: number, running: number) =>
    [waiting > 0 ? `ждут: ${waiting}` : '', running > 0 ? `работают: ${running}` : '']
      .filter(Boolean)
      .join(' · '),
  sandbox: 'Песочница',
  age: (minutes: number) => {
    if (minutes < 1) return 'сейчас';
    if (minutes < 60) return `${minutes} мин`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} ч`;
    return `${Math.floor(hours / 24)} дн`;
  },
  // Карточка чата ждёт и вопросов, и разрешений: «1 вопрос» на просьбе
  // разрешить команду был бы неправдой — называем то, что ждёт.
  asksBadge: (questions: number, permissions: number) =>
    [
      questions > 0 ? `${questions} ${form(questions, 'вопрос', 'вопроса', 'вопросов')}` : '',
      permissions > 0
        ? `${permissions} ${form(permissions, 'разрешение', 'разрешения', 'разрешений')}`
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
  activeEmpty: 'Сейчас ничего не идёт',
  activeEmptyHint: 'Здесь появятся чаты, где агент работает или ждёт вас, и всё, что шло за сутки.',
  noQuestions: 'Нет вопросов',
  noQuestionsHint:
    'Агенты ничего не ждут. Когда кто-то спросит или попросит разрешение — карточка появится здесь.',
  // Карточка вопросов чата.
  step: (current: number, total: number) => `${current} из ${total}`,
  openChat: 'Открыть чат',
  permission: 'Нужно разрешение',
  branchGate: 'Первая правка в основной копии',
  branchGateHint:
    'Агент собирается править файлы прямо в основной копии проекта. Завести отдельную копию с веткой можно в панели.',
  writeHere: 'Писать здесь',
  dontWrite: 'Не писать',
  allow: 'Разрешить',
  deny: 'Запретить',
  details: 'Подробнее',
  hideDetails: 'Свернуть',
  multiHint: 'Можно выбрать несколько',
  other: 'Другое',
  otherPlaceholder: 'Свой ответ',
  otherApply: 'Готово',
  otherMine: 'свой ответ',
  cancel: 'Отмена',
  next: 'Дальше',
  change: 'Изменить',
  send: 'Отправить',
  sendHint: (count: number) =>
    `Все ответы этого чата уйдут вместе — ${count} ${form(count, 'ответ', 'ответа', 'ответов')}`,
  sendFailed: (reason: string) => (reason ? `Не отправлено: ${reason}` : 'Не отправлено'),
  more: (count: number) =>
    `Ещё ${count} ${form(count, 'вопрос', 'вопроса', 'вопросов')} после этого`,
  answered: {
    allow: 'Разрешено',
    deny: 'Запрещено',
    here: 'Писать здесь',
    stop: 'Не писать',
  },
  running: 'агент работает — ответ уйдёт, когда он закончит ход',
};

export type HomeTexts = typeof homeRu;
