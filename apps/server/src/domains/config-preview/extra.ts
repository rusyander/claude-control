import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { EnvVarDraft, HookDraft } from '@agentdeck/contracts';
import type { AppStore } from '../../lib/app-store.ts';
import { readJsonFile, removeEntry } from '../../lib/safe-io.ts';
import { isLocalId, stripLocalPrefix } from '../../lib/settings-source.ts';
import { applyEntityState, findHook, rewriteHooks } from '../entity-toggle.ts';
import {
  deleteEnvVar,
  EnvVarExistsError,
  EnvVarNotFoundError,
  InvalidEnvDraftError,
  saveEnvVar,
} from '../env.ts';
import { deleteHook, upsertHook } from '../hooks.ts';
import { resolveInstructionsTarget, writeInstructions } from '../instructions.ts';
import { assertMcpServerExists } from '../mcp.ts';
import {
  createScript,
  deleteScript,
  resolveScriptPath,
  saveScript,
  ScriptExistsError,
  UnsafeScriptPathError,
} from '../scripts.ts';
import { assertSkillId } from '../skills.ts';
import { disabledSkillsDir } from '../skills/paths.ts';
import {
  failure,
  fileDiff,
  onCopies,
  readText,
  type ClaudePaths,
  type ConfigPreviewFile,
} from './sandbox-diff.ts';
import { codeOf, coded } from '../../lib/server-text.ts';

/**
 * Предпросмотр второго набора видов (волна A, 17.09.2026): хуки, переменные
 * окружения, файл глобальных инструкций, скрипты и переключатель скилла / MCP /
 * права. Приём тот же, что у правил и MCP (`config-preview.ts`): НАСТОЯЩАЯ
 * доменная операция маршрута записи по копиям файлов и отстранённой копии
 * состояния панели, порядок шагов — ровно как в маршруте. Своего сериализатора
 * нет: карточка показывает то, что запишет маршрут, а не догадку о нём.
 */

export type ExtraPreviewRequest =
  | { kind: 'hook'; action: 'save'; id?: string; draft: HookDraft }
  | { kind: 'hook'; action: 'toggle'; id: string; isEnabled: boolean }
  | { kind: 'hook'; action: 'delete'; id: string }
  | { kind: 'env'; action: 'save'; draft: EnvVarDraft }
  | { kind: 'env'; action: 'delete'; key: string; source: string }
  | { kind: 'instructions'; action: 'save'; content: string }
  | { kind: 'script'; action: 'create' | 'save'; id: string; content: string }
  | { kind: 'script'; action: 'delete'; id: string }
  | {
      kind: 'entity';
      action: 'toggle';
      entity: 'skill' | 'mcp' | 'permission';
      id: string;
      isEnabled: boolean;
    };

export const EXTRA_PREVIEW_KINDS = ['hook', 'env', 'instructions', 'script', 'entity'] as const;

export interface ExtraPreview {
  files: ConfigPreviewFile[];
  notes: string[];
  fingerprint: string;
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const fileHash = (path: string): string => (existsSync(path) ? sha(readFileSync(path)) : 'absent');

/** Ошибки доменов без статуса → те же статусы, что отдают маршруты записи; код текста едет дальше. */
function withStatus(error: unknown): unknown {
  const keep = <T extends object>(target: T): T => Object.assign(target, codeOf(error));
  if (error instanceof InvalidEnvDraftError)
    return keep(failure(400, 'invalid_env_draft', error.message));
  if (error instanceof EnvVarNotFoundError)
    return keep(failure(404, 'env_not_found', error.message));
  if (error instanceof EnvVarExistsError) return keep(failure(409, 'env_exists', error.message));
  if (error instanceof UnsafeScriptPathError)
    return keep(failure(400, 'unsafe_path', error.message));
  if (error instanceof ScriptExistsError) return keep(failure(409, 'script_exists', error.message));
  return error;
}

export function previewExtraWrite(
  paths: ClaudePaths,
  store: AppStore,
  request: ExtraPreviewRequest,
): ExtraPreview {
  try {
    // Отпечаток — по настоящему состоянию и ДО операции над копиями.
    const sources = extraSources(paths, store, request);
    const preview = previewOnCopies(paths, store.detached(), request);
    return {
      ...preview,
      fingerprint: sha(JSON.stringify({ sources, notes: preview.notes })),
    };
  } catch (error) {
    throw withStatus(error);
  }
}

function previewOnCopies(
  paths: ClaudePaths,
  state: AppStore,
  request: ExtraPreviewRequest,
): Omit<ExtraPreview, 'fingerprint'> {
  switch (request.kind) {
    case 'hook':
      return previewHook(paths, state, request);
    case 'env':
      return {
        files: onCopies(paths, ['settings', 'settingsLocal', 'secretsEnv'], (sandbox) => {
          if (request.action === 'save') {
            saveEnvVar(
              sandbox.settings,
              sandbox.secretsEnv,
              request.draft,
              undefined,
              sandbox.settingsLocal,
            );
          } else {
            deleteEnvVar(
              sandbox.settings,
              sandbox.secretsEnv,
              request.key,
              request.source,
              undefined,
              sandbox.settingsLocal,
            );
          }
        }),
        notes: [],
      };
    case 'instructions':
      return previewInstructions(paths, state, request.content);
    case 'script':
      return previewScript(paths, request);
    default:
      return previewEntityToggle(paths, state, request);
  }
}

/** Шаги маршрутов `/api/hooks` и переключателя сущностей — в их порядке. */
function previewHook(
  paths: ClaudePaths,
  state: AppStore,
  request: Extract<ExtraPreviewRequest, { kind: 'hook' }>,
): Omit<ExtraPreview, 'fingerprint'> {
  const found =
    request.id === undefined ? undefined : findHook({ paths, store: state }, request.id);
  if (request.id !== undefined && !found)
    throw coded(failure(404, 'hook_not_found', 'Хук не найден'), 'hook-not-found');
  const id = found?.id ?? request.id ?? '';
  const target = (sandbox: ClaudePaths) =>
    isLocalId(id)
      ? { path: sandbox.settingsLocal, source: 'settings-local' as const }
      : { path: sandbox.settings, source: 'settings' as const };

  if (request.action === 'save') {
    // Скрипт по имени агент не создаёт: это запись второго файла, которую
    // карточка одного диффа не показала бы.
    if (request.draft.scriptName?.trim()) {
      throw coded(
        failure(400, 'script_not_supported', 'Скрипт хука создаётся отдельным действием.'),
        'hook-script-separate',
      );
    }
    return {
      files: onCopies(paths, ['settings', 'settingsLocal'], (sandbox) => {
        upsertHook(
          sandbox.settings,
          sandbox.hooks,
          request.id === undefined ? null : stripLocalPrefix(id),
          request.draft,
          state,
          undefined,
          target(sandbox),
        );
      }),
      notes: [],
    };
  }

  if (request.action === 'delete') {
    return {
      files: onCopies(paths, ['settings', 'settingsLocal'], (sandbox) => {
        deleteHook(sandbox.settings, id, state, undefined, target(sandbox));
      }),
      notes: [],
    };
  }

  // Локальный хук панель не выключает (см. `applyEntityState`): карточка обязана
  // сказать это до клика, а не показать пустой дифф.
  const notes: string[] = [];
  const files = onCopies(paths, ['settings', 'settingsLocal'], (sandbox) => {
    const deps = { paths: sandbox, store: state };
    state.setEnabled('hook', id, request.isEnabled, found?.legacyId);
    const effective = !state.isDisabled('hook', id, found?.legacyId);
    if (effective !== request.isEnabled) {
      notes.push('Хук остаётся выключенным: его гасит группа.');
    }
    applyEntityState(deps, 'hook', id, effective);
    rewriteHooks(deps);
  });
  if (files.length === 0 && found?.source === 'settings-local') {
    notes.push('Хук из settings.local.json панель не переключает: файл не изменится.');
  }
  return { files, notes };
}

function previewInstructions(
  paths: ClaudePaths,
  state: AppStore,
  content: string,
): Omit<ExtraPreview, 'fingerprint'> {
  const target = resolveInstructionsTarget(state, paths.claudeMd);
  if (!target) {
    throw failure(
      400,
      'section_unsupported',
      'Активный CLI не поддерживает глобальные инструкции.',
    );
  }
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-preview-'));
  try {
    const copy = join(root, target.fileName);
    const existed = existsSync(target.filePath);
    if (existed) copyFileSync(target.filePath, copy);
    writeInstructions({ ...target, filePath: copy }, content, undefined);
    const before = readText(target.filePath);
    const after = readText(copy);
    return {
      files: before === after ? [] : [fileDiff(target.filePath, before, after, existed)],
      notes: [],
    };
  } finally {
    removeEntry(root);
  }
}

function previewScript(
  paths: ClaudePaths,
  request: Extract<ExtraPreviewRequest, { kind: 'script' }>,
): Omit<ExtraPreview, 'fingerprint'> {
  const real = resolveScriptPath(paths.hooks, request.id);
  const existed = existsSync(real);
  if (request.action !== 'create' && !existed) {
    throw coded(
      failure(404, 'script_not_found', `Скрипт «${request.id}» не найден`),
      'script-not-found-quoted',
      { id: request.id },
    );
  }
  const root = mkdtempSync(join(tmpdir(), 'agentdeck-preview-'));
  try {
    const hooks = join(root, 'hooks');
    const copy = join(hooks, relative(paths.hooks, real));
    mkdirSync(dirname(copy), { recursive: true });
    if (existed) copyFileSync(real, copy);
    if (request.action === 'create') createScript(hooks, request.id, request.content);
    else if (request.action === 'save') saveScript(hooks, request.id, request.content, undefined);
    else deleteScript(hooks, request.id, undefined);
    const before = readText(real);
    const after = readText(copy);
    return {
      files: before === after && existed ? [] : [fileDiff(real, before, after, existed)],
      notes: request.action === 'delete' ? ['Копия файла остаётся в истории.'] : [],
    };
  } finally {
    removeEntry(root);
  }
}

/** Шаги маршрута `/api/entities/:kind/:id/enabled` для скилла, MCP и права. */
function previewEntityToggle(
  paths: ClaudePaths,
  state: AppStore,
  request: Extract<ExtraPreviewRequest, { kind: 'entity' }>,
): Omit<ExtraPreview, 'fingerprint'> {
  const { entity, id, isEnabled } = request;
  if (entity === 'skill') assertSkillId(id);
  if (entity === 'mcp') assertMcpServerExists(paths.mcpConfig, id);
  state.setEnabled(entity, id, isEnabled);
  const effective = !state.isDisabled(entity, id);
  const notes = effective === isEnabled ? [] : ['Остаётся выключенным: его гасит группа.'];

  if (entity === 'skill') {
    // Скилл включается переносом папки — файлы не меняются, меняется место.
    const on = join(paths.skills, id);
    const off = join(disabledSkillsDir(paths.skills), id);
    const [from, to] = effective ? [off, on] : [on, off];
    if (!existsSync(from) && !existsSync(to)) {
      throw coded(
        failure(404, 'skill_not_found', `Скилл «${id}» не найден`),
        'skill-not-found-quoted',
        { id },
      );
    }
    return {
      files: [],
      notes: existsSync(from) ? [...notes, `Папка ${from} переносится в ${to}.`] : notes,
    };
  }

  const files = onCopies(
    paths,
    entity === 'mcp' ? ['mcpConfig'] : ['settings', 'settingsLocal'],
    (sandbox) => {
      applyEntityState({ paths: sandbox, store: state }, entity, id, effective);
    },
  );
  return { files, notes };
}

/** Исходное состояние, из которого посчитана карточка. */
function extraSources(paths: ClaudePaths, store: AppStore, request: ExtraPreviewRequest): unknown {
  switch (request.kind) {
    case 'hook':
      return {
        settings: fileHash(paths.settings),
        local: fileHash(paths.settingsLocal),
        disabled: store.getDisabledIds('hook'),
        snapshots: store.getDisabledHooks(),
      };
    case 'env':
      return [paths.settings, paths.settingsLocal, paths.secretsEnv].map(fileHash);
    case 'instructions': {
      const target = resolveInstructionsTarget(store, paths.claudeMd);
      return target ? fileHash(target.filePath) : 'unsupported';
    }
    case 'script':
      return fileHash(resolveScriptPath(paths.hooks, request.id));
    default: {
      const disabled = store.getDisabledIds(request.entity);
      if (request.entity === 'skill') {
        return {
          disabled,
          places: [
            join(paths.skills, request.id),
            join(disabledSkillsDir(paths.skills), request.id),
          ].map(existsSync),
        };
      }
      if (request.entity === 'mcp') {
        const config = readJsonFile<Record<string, unknown>>(paths.mcpConfig, {});
        return {
          disabled,
          servers: sha(
            JSON.stringify({
              servers: config.mcpServers ?? null,
              off: config.mcpServersDisabled ?? null,
            }),
          ),
        };
      }
      return {
        disabled,
        file: fileHash(isLocalId(request.id) ? paths.settingsLocal : paths.settings),
      };
    }
  }
}
