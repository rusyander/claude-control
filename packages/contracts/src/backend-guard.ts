/**
 * Защита бэкенда — готовая проектная группа: хук `PreToolUse` спрашивает
 * человека перед разрушительной командой (снос таблицы, откат миграций,
 * terraform/kubectl/helm, удаление томов, обращение к проду), правило объясняет
 * агенту, как с этим жить. Ставится в `.claude/` проекта; панель тот же вопрос
 * задаёт и в своём чате — там автоподтверждение такие команды не пропускает.
 */

/** Правила в порядке проверки: первое совпадение — причина вопроса. */
export const BACKEND_GUARD_RULES = [
  'prod-target',
  'sql-drop',
  'sql-truncate',
  'sql-unbounded',
  'migration-down',
  'infra-change',
  'volume-delete',
] as const;

export type BackendGuardRule = (typeof BACKEND_GUARD_RULES)[number];

/** Файл защиты в проекте: на месте, нет или отличается от версии панели. */
export type BackendGuardPartState = 'ok' | 'missing' | 'changed';

export interface BackendGuardParts {
  /** `.claude/hooks/backend-guard.mjs`; `changed` — правлен руками или от старой версии. */
  script: BackendGuardPartState;
  /** Запись хука в `.claude/settings.json`. */
  hook: 'ok' | 'missing';
  /** `.claude/rules/backend-safety.md` для агента. */
  rule: BackendGuardPartState;
}

export interface BackendGuardSettings {
  /** Адреса, IP и имена контекстов прода: команда с любым из них спрашивает. */
  prodMarkers: string[];
  /** Выключенные правила; пусто — спрашивают все. */
  disabled: BackendGuardRule[];
}

export interface BackendGuardStatus {
  /** `none` — не ставилась; `partial` — часть файлов пропала или правлена. */
  state: 'none' | 'installed' | 'partial';
  parts: BackendGuardParts;
  settings: BackendGuardSettings;
  /** Группа панели, которая держит хук и правило. */
  groupId?: string;
  groupName?: string;
  /** Пути относительно корня проекта — окно называет их человеку. */
  files: { script: string; settings: string; rule: string; config: string };
}

export interface BackendGuardCheck {
  /** Совпало правило — команда спросит; нет — пройдёт без вопроса защиты. */
  hit?: { rule: BackendGuardRule; match: string };
}

/** Причина вопроса в карточке прав чата: защита бэкенда узнала команду. */
export interface PermissionGuardReason {
  rule: BackendGuardRule;
  match: string;
}
