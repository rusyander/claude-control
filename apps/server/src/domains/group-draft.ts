import type { Group, GroupDraft, GroupMemberKind } from '@claude-control/contracts';
import { ENV_KEY_PATTERN } from '@claude-control/contracts/env-secret';

/**
 * Проверка черновика группы ДО записи и ошибки домена для маршрутов.
 *
 * Тело приходит от формы, от телефона и от скриптов, и раньше всё, что не
 * падало пятисоткой, уезжало в state.json как есть: участник без id, `env`
 * строкой, `projectPaths` строкой — а страница групп потом падала на
 * `paths.map`. Схема из contracts здесь недоступна (пакет реэкспортирует модули
 * без расширений, Node его как значение не подключает), поэтому проверка
 * ручная — по тем же полям, что и в `groupDraftSchema`.
 *
 * Ошибки несут `statusCode` и `code`, как у MCP: маршрут отвечает 400/404/409 с
 * причиной. Явные поля, а не parameter properties — рантайм читает TypeScript
 * через strip-types.
 */

/** Черновик не годится для записи; причина — человеку, маршрут отвечает 400. */
export class InvalidGroupDraftError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_group_draft';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidGroupDraftError';
  }
}

/** Группы с таким id нет — 404, а не молчаливое создание или «ok». */
export class GroupNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';

  constructor(id: string) {
    super(`Группы «${id}» нет.`);
    this.name = 'GroupNotFoundError';
  }
}

/** Имя занято — 409: по имени группу находят в списке и подтверждают удаление. */
export class GroupExistsError extends Error {
  readonly statusCode = 409;
  readonly code = 'group_exists';

  constructor(name: string) {
    super(
      `Группа «${name}» уже есть — по имени её находят и удаляют, двух одинаковых быть не должно.`,
    );
    this.name = 'GroupExistsError';
  }
}

/** Автоматизации с таким id нет — 404. */
export class AutomationNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'not_found';

  constructor(id: string) {
    super(`Сценария «${id}» нет.`);
    this.name = 'AutomationNotFoundError';
  }
}

const MEMBER_KINDS: readonly GroupMemberKind[] = [
  'rule',
  'hook',
  'skill',
  'mcp',
  'permission',
  'group',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

function assertOptionalString(body: Record<string, unknown>, field: string, what: string): void {
  if (body[field] !== undefined && typeof body[field] !== 'string') {
    throw new InvalidGroupDraftError(`Поле ${field} (${what}) — строка.`);
  }
}

function assertMembers(members: unknown): void {
  if (!Array.isArray(members)) {
    throw new InvalidGroupDraftError('Поле members — список участников.');
  }
  for (const member of members) {
    if (
      !isRecord(member) ||
      !MEMBER_KINDS.includes(member.kind as GroupMemberKind) ||
      typeof member.id !== 'string' ||
      member.id.trim() === ''
    ) {
      throw new InvalidGroupDraftError(
        `Участник — объект {kind, id}: kind один из ${MEMBER_KINDS.join(', ')}, id — непустая строка.`,
      );
    }
  }
}

function assertEnv(env: unknown): void {
  if (!isRecord(env)) {
    throw new InvalidGroupDraftError('Поле env — объект «имя переменной → значение».');
  }
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_PATTERN.test(key)) {
      throw new InvalidGroupDraftError(
        `Имя переменной «${key}» не годится: латиница, цифры и подчёркивание, не с цифры.`,
      );
    }
    if (typeof value !== 'string') {
      throw new InvalidGroupDraftError(`Значение переменной ${key} — строка.`);
    }
  }
}

function assertScenario(scenario: unknown): void {
  if (!isRecord(scenario)) {
    throw new InvalidGroupDraftError('Поле scenario — объект сценария.');
  }
  assertOptionalString(scenario, 'when', 'когда уместен');
  assertOptionalString(scenario, 'trigger', 'регулярное выражение');
  if (scenario.steps === undefined) return;
  if (!Array.isArray(scenario.steps)) {
    throw new InvalidGroupDraftError('Шаги сценария — список.');
  }
  for (const step of scenario.steps) {
    if (!isRecord(step))
      throw new InvalidGroupDraftError('Шаг сценария — объект {title, body, gate}.');
    assertOptionalString(step, 'title', 'заголовок шага');
    assertOptionalString(step, 'body', 'текст шага');
    assertOptionalString(step, 'gate', 'условие шага');
  }
}

/** Форма тела: имя обязательно, остальное — если пришло, то нужного вида. Имя обрезается. */
export function assertGroupDraft(draft: unknown): asserts draft is GroupDraft {
  if (!isRecord(draft)) {
    throw new InvalidGroupDraftError('Тело запроса должно быть объектом с описанием набора.');
  }
  // Набор без имени человеку не опознать: в списке он безымянная строка,
  // выключить которую можно только угадав.
  if (typeof draft.name !== 'string' || draft.name.trim() === '') {
    throw new InvalidGroupDraftError('Не указано имя набора');
  }
  draft.name = draft.name.trim();

  assertOptionalString(draft, 'description', 'описание');
  assertOptionalString(draft, 'color', 'цвет');
  assertOptionalString(draft, 'icon', 'иконка');
  if (draft.members !== undefined) assertMembers(draft.members);
  if (draft.env !== undefined) assertEnv(draft.env);
  if (draft.projectPaths !== undefined) {
    if (
      !Array.isArray(draft.projectPaths) ||
      draft.projectPaths.some((path) => typeof path !== 'string')
    ) {
      throw new InvalidGroupDraftError('Поле projectPaths — список путей к каталогам (строк).');
    }
  }
  // `null` — «сценария нет», как и отсутствие поля: форма шлёт его, снимая сценарий.
  if (draft.scenario !== undefined && draft.scenario !== null) assertScenario(draft.scenario);
  if (draft.isEnabled !== undefined && typeof draft.isEnabled !== 'boolean') {
    throw new InvalidGroupDraftError('Поле isEnabled — true или false.');
  }
}

/**
 * Имя группы уникально без учёта регистра и краёв: диалог удаления просит
 * набрать имя, и два одинаковых имени сделали бы его неоднозначным.
 */
export function assertGroupNameFree(
  groups: readonly Group[],
  name: string,
  exceptId?: string,
): void {
  const needle = name.trim().toLocaleLowerCase();
  const taken = groups.find(
    (group) => group.id !== exceptId && group.name.trim().toLocaleLowerCase() === needle,
  );
  if (taken) throw new GroupExistsError(taken.name);
}
