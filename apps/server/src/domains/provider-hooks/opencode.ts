import type { ProviderHookAction, ProviderHooksDraft } from '@claude-control/contracts';
import { readTextFile, writeTextFile } from '../../lib/safe-io.ts';
import { UnrecognizedFormatError } from '../../lib/codex-toml.ts';
import { parseProviderJsonObject, stableJson } from '../../lib/provider-json.ts';
import {
  applyOpencodeHook,
  readOpencodeHook,
  type OpencodeHookAction,
  type OpencodeHookDraft,
  type OpencodeHookPatternGroup,
} from '../../lib/opencode-hook.ts';
import { WriteDisabledError, backupNameOf } from './target.ts';
import type { ProviderHooksTarget, RawOpencodeConfig } from './types.ts';

/**
 * Модель `opencode-events`: ключ `experimental.hook` в `opencode.json` — ровно
 * два задокументированных события (`file_edited`, `session_completed`) с
 * действиями-argv.
 */

/**
 * Проекция «всё, кроме ключа `experimental.hook`». По ней результат сверяется с
 * оригиналом: изменился любой чужой ключ файла (`$schema`, `model`, `mcp`,
 * `permission`, `plugin`, …) либо любой чужой ключ внутри `experimental` —
 * запись отменяется. Ключи сортируются рекурсивно (`stableJson`).
 */
function otherKeysProjection(config: RawOpencodeConfig): string {
  const rest: Record<string, unknown> = { ...config };

  const experimental = config.experimental;
  if (experimental && typeof experimental === 'object' && !Array.isArray(experimental)) {
    const experimentalRest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(experimental as Record<string, unknown>)) {
      if (key === 'hook') continue;
      experimentalRest[key] = value;
    }
    // Внутри `hook` панель ведёт только два события — остальные тоже чужие.
    const hook = (experimental as Record<string, unknown>).hook;
    if (hook && typeof hook === 'object' && !Array.isArray(hook)) {
      const hookRest: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(hook as Record<string, unknown>)) {
        if (key === 'file_edited' || key === 'session_completed') continue;
        hookRest[key] = value;
      }
      if (Object.keys(hookRest).length > 0) experimentalRest.hook = hookRest;
    }
    if (Object.keys(experimentalRest).length > 0) rest.experimental = experimentalRest;
    else delete rest.experimental;
  }

  return stableJson(rest);
}

/** Действия черновика в форму адаптера (типы совпадают структурно, копируем явно). */
function toLibActions(actions: ProviderHookAction[]): OpencodeHookAction[] {
  return actions.map((action) => ({
    command: [...action.command],
    ...(action.environment?.length
      ? { environment: action.environment.map((pair) => ({ ...pair })) }
      : {}),
  }));
}

function toLibDraft(draft: ProviderHooksDraft): OpencodeHookDraft {
  const fileEdited: OpencodeHookPatternGroup[] = draft.fileEdited.map((group) => ({
    pattern: group.pattern,
    actions: toLibActions(group.actions),
  }));
  return { fileEdited, sessionCompleted: toLibActions(draft.sessionCompleted) };
}

/**
 * Записать хуки, поменяв ТОЛЬКО ключ `experimental.hook`.
 *
 * Событие из черновика перезаписывается целиком; пустое событие УДАЛЯЕТСЯ;
 * событие, форму которого панель не поняла, не трогается вовсе (черновик,
 * который его называет, → 422). Пустой `hook` удаляет ключ, пустой
 * `experimental` — ключ `experimental`; `{}` в файле не появляется.
 * Нет файла → создаётся только с ключом `experimental`.
 */
export function saveProviderHooks(
  target: ProviderHooksTarget,
  draft: ProviderHooksDraft,
  backupDir: string | undefined,
): string | undefined {
  // Ключ снят с записи — отказ ДО чтения файла: писать в чужой конфиг ключ,
  // которого нет ни в документации CLI, ни в его схеме, панель не станет.
  if (target.writeDisabledReason) throw new WriteDisabledError(target.writeDisabledReason);
  // Писатель здесь ровно один — OpenCode. Цель другого формата сюда попасть не
  // должна; попала — это ошибка вызывающего, а не повод переписать чужой файл.
  if (target.format !== 'opencode-json') throw new UnrecognizedFormatError();

  const text = readTextFile(target.filePath);
  const original: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};
  // Второй разбор — рабочее дерево (первый остаётся эталоном «как было»).
  const config: RawOpencodeConfig = text.trim()
    ? parseProviderJsonObject<RawOpencodeConfig>(text)
    : {};

  const libDraft = toLibDraft(draft);
  const experimental = applyOpencodeHook(config.experimental, libDraft);
  if (experimental) config.experimental = experimental;
  else delete config.experimental;

  const next = `${JSON.stringify(config, null, 2)}\n`;

  // Контроль ДО записи: итог разбирается, оба события совпали с намерением, а все
  // прочие ключи файла, `experimental` и незнакомые события целы.
  const parsed = parseProviderJsonObject<RawOpencodeConfig>(next);
  const check = readOpencodeHook(parsed.experimental);
  if (stableJson(check.fileEdited) !== stableJson(libDraft.fileEdited)) {
    throw new UnrecognizedFormatError();
  }
  if (stableJson(check.sessionCompleted) !== stableJson(libDraft.sessionCompleted)) {
    throw new UnrecognizedFormatError();
  }
  if (otherKeysProjection(original) !== otherKeysProjection(parsed)) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm по умолчанию: файл пересобран из JSON.stringify (LF, без BOM),
  // поэтому форму пользовательского файла (BOM/CRLF) возвращает safe-io.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
  });
}
