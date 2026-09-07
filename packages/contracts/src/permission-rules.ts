import { record, string, boolean } from 'zod';

/**
 * Правила прав: что панель разрешает агенту сама, а что выносит человеку
 * карточкой «Разрешить/Запретить».
 *
 * Раньше эта граница была одна на всех и зашита в код: «безвозвратное
 * спрашиваем, остальное разрешаем». Список того, что считается безвозвратным,
 * человек не видел и подвинуть не мог — оставалось щёлкать «Разрешить» по
 * десятку раз за прогон либо не включать автоподтверждение вовсе. Теперь та же
 * граница разложена на именованные правила, каждое со своим тумблером.
 *
 * ВКЛЮЧЕНО — панель подтверждает сама. ВЫКЛЮЧЕНО — спрашивает человека.
 *
 * Правила глобальные: они лежат в настройках панели, а не в разговоре и не в
 * проекте. Включённое в одном проекте действует во всех, и на телефоне тоже —
 * потому что решение «пусть агент сам пишет комментарии в MR» относится к
 * человеку и его сервисам, а не к каталогу, из которого он это разрешил.
 *
 * Что правила НЕ отменяют: `deny` и `ask` из settings.json (человек сам сказал
 * «спрашивай» — это сильнее), выключенный тумблер правок в шапке чата («только
 * чтение») и вопрос человеку (`AskUserQuestion`). Разбор конкретных команд и
 * инструментов — на сервере (`domains/chat/auto-approve.ts`).
 */

/**
 * Идентификаторы правил в порядке показа: сперва то, что разрешено из коробки
 * (обычная работа агента), затем то, что по умолчанию спрашивает.
 */
export const PERMISSION_RULE_IDS = [
  'externalWrite',
  'gitWrite',
  'filesDelete',
  'gitHistory',
  'database',
  'infrastructure',
  'packagePublish',
  'externalDestroy',
  'networkExec',
] as const;

export type PermissionRuleId = (typeof PERMISSION_RULE_IDS)[number];

/**
 * Положение из коробки (решение владельца, 07.09.2026): ЗАПИСИ разрешены, СНОС
 * спрашивает. Комментарий в MR, тред, тикет, коммит и обычный push — обычная
 * работа, ради которой агента и запускают; удаление файлов, затирание истории,
 * снос базы и слияние чужого запроса — то, чего не отменить, и там остановка
 * стоит дешевле ошибки.
 */
export const PERMISSION_RULE_DEFAULTS: Readonly<Record<PermissionRuleId, boolean>> = {
  externalWrite: true,
  gitWrite: true,
  filesDelete: false,
  gitHistory: false,
  database: false,
  infrastructure: false,
  packagePublish: false,
  externalDestroy: false,
  networkExec: false,
};

/** Сохранённые положения тумблеров: id правила → разрешено без вопроса. */
export const permissionRulesSchema = record(string(), boolean());

/**
 * Действующие правила: сохранённые положения поверх значений по умолчанию.
 * Неизвестный ключ из хранилища игнорируется — набор правил меняется с кодом,
 * и настройка от прошлой версии не должна ничего решать.
 */
export function resolvePermissionRules(
  saved: Record<string, boolean> | undefined,
): Record<PermissionRuleId, boolean> {
  const rules = { ...PERMISSION_RULE_DEFAULTS };
  for (const id of PERMISSION_RULE_IDS) {
    const value = saved?.[id];
    if (typeof value === 'boolean') rules[id] = value;
  }
  return rules;
}

/** Правила, разрешённые без вопроса, — в том виде, в каком их проверяет сервер. */
export function allowedPermissionRules(saved: Record<string, boolean> | undefined): Set<string> {
  const rules = resolvePermissionRules(saved);
  return new Set(PERMISSION_RULE_IDS.filter((id) => rules[id]));
}
