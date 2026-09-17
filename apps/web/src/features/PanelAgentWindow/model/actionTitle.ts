/** Ключ словаря с человеческим названием действия реестра сервера. */
export const actionTitleKey = (name: string): string => `panelAgent.actions.${name}`;

/**
 * Название действия для человека: «Создать проект», а не `create_project`.
 * Ключа нет (действие добавили на сервере, словарь отстал) — само имя: окно не
 * должно ломаться, а пропуск ловит `actionTitle.test.ts`.
 */
export function actionTitle(
  name: string,
  t: (key: string) => string,
  exists: (key: string) => boolean,
): string {
  const key = actionTitleKey(name);
  return exists(key) ? t(key) : name;
}
