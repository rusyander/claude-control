import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { PermissionDraft, RuleDraft, SkillDraft } from '@agentdeck/contracts';
import type { AppStore } from '../lib/app-store.ts';
import { removeEntry } from '../lib/safe-io.ts';
import { isLocalId, stripLocalPrefix } from '../lib/settings-source.ts';
import { slugify } from '../lib/slug.ts';
import { applyEntityState } from './entity-toggle.ts';
import { assertMcpDraft, deleteMcpServer, saveMcpServer } from './mcp.ts';
import { hasOAuthTokens } from './mcp-oauth.ts';
import {
  assertPermissionDraft,
  deletePermission,
  hasPermission,
  PermissionExistsError,
  PermissionNotFoundError,
  savePermission,
} from './permissions.ts';
import { deleteRule, readRules, saveRule } from './rules.ts';
import { assertSkillId, saveSkill } from './skills.ts';
import { disabledSkillsDir } from './skills/paths.ts';
import { configSourceFingerprint } from './config-preview/fingerprint.ts';
import {
  failure,
  fileDiff,
  onCopy,
  readText,
  type ClaudePaths,
  type ConfigPreviewFile,
} from './config-preview/sandbox-diff.ts';
import { previewExtraWrite, type ExtraPreviewRequest } from './config-preview/extra.ts';

/**
 * Предпросмотр записи в конфигурацию Claude Code — для карточки агента панели.
 *
 * Тот же приём, что у чужих CLI (`provider-preview.ts`): выполняется НАСТОЯЩАЯ
 * доменная операция, которой пользуется маршрут записи, но по временной копии
 * файла, а отметки она переносит в отстранённой копии состояния
 * (`AppStore.detached`). Своего сериализатора здесь нет и быть не должно: он
 * разошёлся бы с записью, и карточка показывала бы не то, что окажется в файле.
 *
 * Проверки маршрутов записи повторены с теми же ошибками (404/409/400), чтобы
 * карточка не оказалась добрее записи. Резервных копий предпросмотр не делает.
 */

export type ConfigPreviewRequest =
  | { kind: 'rule'; action: 'save'; id?: string; draft: RuleDraft }
  | { kind: 'rule'; action: 'toggle'; id: string; isEnabled: boolean }
  | { kind: 'rule'; action: 'delete'; id: string }
  | { kind: 'skill'; action: 'save'; id?: string; draft: SkillDraft }
  | { kind: 'skill'; action: 'delete'; id: string }
  | { kind: 'permission'; action: 'add'; draft: PermissionDraft }
  | { kind: 'permission'; action: 'delete'; id: string }
  | { kind: 'mcp'; action: 'save'; id?: string; draft: unknown }
  | { kind: 'mcp'; action: 'delete'; id: string }
  | ExtraPreviewRequest;

export type { ConfigPreviewFile } from './config-preview/sandbox-diff.ts';

export interface ConfigPreviewResponse {
  files: ConfigPreviewFile[];
  /** Что меняется помимо файлов (отметки панели, вход OAuth) — по-русски, для карточки. */
  notes: string[];
  /**
   * Хеш исходного состояния (байты целевых файлов, отметки) вместе с заметками.
   * Действие агента сверяет его перед записью одобренной карточки.
   */
  fingerprint: string;
}

export function previewConfigWrite(
  paths: ClaudePaths,
  store: AppStore,
  request: ConfigPreviewRequest,
): ConfigPreviewResponse {
  if (!isBaseRequest(request)) return previewExtraWrite(paths, store, request);
  // Отпечаток — по настоящему состоянию и ДО операции над копией: отстранённое
  // состояние предпросмотр сам сдвигает (отметки переключения).
  const id = request.kind === 'permission' && request.action === 'add' ? undefined : request.id;
  const sources = configSourceFingerprint(paths, store, {
    kind: request.kind,
    action: request.action,
    ...(id === undefined ? {} : { id }),
    ...(request.kind === 'skill' ? { skillPlaces: skillPlaces(paths, skillIdOf(request)) } : {}),
  });
  const preview = previewOnCopy(paths, store.detached(), request);
  return {
    ...preview,
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ sources, notes: preview.notes }))
      .digest('hex'),
  };
}

type BaseRequest = Exclude<ConfigPreviewRequest, ExtraPreviewRequest>;

function isBaseRequest(request: ConfigPreviewRequest): request is BaseRequest {
  return ['rule', 'skill', 'permission', 'mcp'].includes(request.kind);
}

function previewOnCopy(
  paths: ClaudePaths,
  state: AppStore,
  request: BaseRequest,
): Omit<ConfigPreviewResponse, 'fingerprint'> {
  switch (request.kind) {
    case 'rule':
      return previewRule(paths, state, request);
    case 'skill':
      return previewSkill(paths, request);
    case 'permission':
      return previewPermission(paths, state, request);
    default:
      return previewMcp(paths, request);
  }
}

/** Где может лежать скилл: включённый и выключенный каталог. */
function skillPlaces(paths: ClaudePaths, id: string): string[] {
  return [join(paths.skills, id), join(disabledSkillsDir(paths.skills), id)];
}

function previewRule(
  paths: ClaudePaths,
  state: AppStore,
  request: Extract<ConfigPreviewRequest, { kind: 'rule' }>,
): Omit<ConfigPreviewResponse, 'fingerprint'> {
  const id = request.id;
  if (id !== undefined && !readRules(paths.claudeMd, state).some((rule) => rule.id === id)) {
    throw failure(404, 'rule_not_found', 'Правило не найдено');
  }

  if (request.action === 'save') {
    return {
      files: [
        onCopy(paths.claudeMd, (copy) =>
          saveRule(copy, request.id ?? '', request.draft, state, undefined),
        ),
      ],
      notes: [],
    };
  }

  if (request.action === 'delete') {
    // Порядок маршрута: след снимается ДО удаления (см. rule-routes).
    state.removeEntity('rule', request.id);
    return {
      files: [onCopy(paths.claudeMd, (copy) => deleteRule(copy, request.id, state, undefined))],
      notes: [],
    };
  }

  // Переключение — ровно как маршрут `/api/entities/:kind/:id/enabled`: отметка,
  // затем итог с учётом групп, затем применение к файлу.
  state.setEnabled('rule', request.id, request.isEnabled);
  const effective = !state.isDisabled('rule', request.id);
  const file = onCopy(paths.claudeMd, (copy) =>
    applyEntityState(
      { paths: { ...paths, claudeMd: copy }, store: state },
      'rule',
      request.id,
      effective,
    ),
  );
  const notes =
    effective === request.isEnabled
      ? []
      : [
          'Правило остаётся выключенным: его гасит группа, одиночный переключатель её не пересилит.',
        ];
  return { files: [file], notes };
}

/** Id скилла: явный — проверенный, у нового — слаг имени, как в `saveSkill`. */
function skillIdOf(request: Extract<ConfigPreviewRequest, { kind: 'skill' }>): string {
  if (request.id !== undefined) return assertSkillId(request.id);
  return request.action === 'save' ? slugify(request.draft.name) : '';
}

function previewSkill(
  paths: ClaudePaths,
  request: Extract<ConfigPreviewRequest, { kind: 'skill' }>,
): Omit<ConfigPreviewResponse, 'fingerprint'> {
  const id = skillIdOf(request);
  const places = skillPlaces(paths, id);

  if (request.action === 'delete') {
    const dir = places.find((place) => existsSync(place));
    if (!dir) throw failure(404, 'skill_not_found', `Скилл «${id}» не найден`);
    const skillFile = join(dir, 'SKILL.md');
    // У удаления папки сериализатора нет: дифф — уходящий SKILL.md, остальные
    // файлы названы списком. Папка целиком уезжает в резервную копию.
    const others = listFiles(dir).filter((file) => file !== 'SKILL.md');
    return {
      files: [fileDiff(skillFile, readText(skillFile), '', existsSync(skillFile))],
      notes: [
        `Папка ${dir} удаляется целиком (копия — в истории).`,
        ...(others.length > 0 ? [`Вместе с ней файлы: ${others.join(', ')}`] : []),
      ],
    };
  }

  // Копия обоих мест скилла: `saveSkill` сам решает, куда писать (включён или
  // выключен) и не занято ли имя — ему нужна та же картина, что на диске.
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-skill-preview-'));
  try {
    const sandboxSkills = join(root, 'skills');
    const sandboxPlaces = [join(sandboxSkills, id), join(disabledSkillsDir(sandboxSkills), id)];
    places.forEach((place, index) => {
      if (!existsSync(place)) return;
      mkdirSync(sandboxPlaces[index]!, { recursive: true });
      const file = join(place, 'SKILL.md');
      if (existsSync(file)) copyFileSync(file, join(sandboxPlaces[index]!, 'SKILL.md'));
    });

    saveSkill(sandboxSkills, request.id ?? null, request.draft, undefined);

    const files = places.flatMap((place, index) => {
      const real = join(place, 'SKILL.md');
      const copy = join(sandboxPlaces[index]!, 'SKILL.md');
      const before = readText(real);
      const after = readText(copy);
      return before === after ? [] : [fileDiff(real, before, after, existsSync(real))];
    });
    return { files, notes: [] };
  } finally {
    removeEntry(root);
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'));
}

function previewPermission(
  paths: ClaudePaths,
  state: AppStore,
  request: Extract<ConfigPreviewRequest, { kind: 'permission' }>,
): Omit<ConfigPreviewResponse, 'fingerprint'> {
  if (request.action === 'add') {
    const draft = assertPermissionDraft(request.draft);
    if (hasPermission(paths.settings, `${draft.decision}:${draft.pattern}`)) {
      throw new PermissionExistsError(draft.pattern);
    }
    return {
      files: [onCopy(paths.settings, (copy) => savePermission(copy, null, draft, undefined))],
      notes: [],
    };
  }

  const target = isLocalId(request.id) ? paths.settingsLocal : paths.settings;
  const bareId = stripLocalPrefix(request.id);
  if (!hasPermission(target, bareId)) {
    // Выключенное право живёт только отметкой — маршрут снимает её, файл не трогает.
    if (!state.getDisabledIds('permission').includes(request.id)) {
      throw new PermissionNotFoundError(request.id);
    }
    return {
      files: [],
      notes: ['Право выключено и в файле отсутствует: снимается только отметка панели.'],
    };
  }
  return {
    files: [onCopy(target, (copy) => deletePermission(copy, bareId, undefined))],
    notes: [],
  };
}

function previewMcp(
  paths: ClaudePaths,
  request: Extract<ConfigPreviewRequest, { kind: 'mcp' }>,
): Omit<ConfigPreviewResponse, 'fingerprint'> {
  if (request.action === 'delete') {
    const file = onCopy(paths.mcpConfig, (copy) => deleteMcpServer(copy, request.id, undefined));
    const notes = hasOAuthTokens(paths.appData, request.id)
      ? ['Сохранённый вход OAuth этого сервера тоже удаляется.']
      : [];
    return { files: [file], notes };
  }

  const draft = request.draft;
  assertMcpDraft(draft, request.id === undefined ? undefined : { currentName: request.id });
  const file = onCopy(paths.mcpConfig, (copy) =>
    saveMcpServer(copy, request.id ?? null, draft, undefined),
  );
  const notes =
    request.id !== undefined && request.id !== draft.name
      ? [`Переименование: отметки и вход OAuth переезжают с «${request.id}» на «${draft.name}».`]
      : [];
  return { files: [file], notes };
}
