import { existsSync, readFileSync } from 'node:fs';
import type {
  CodexApprovalPolicy,
  CodexPermissionDraft,
  CodexSandboxMode,
} from '@claude-control/contracts';
import { writeTextFile } from '../../lib/safe-io.ts';
import {
  UnrecognizedFormatError,
  parseCodexToml,
  upsertCodexRootScalar,
} from '../../lib/codex-toml.ts';
import {
  APPROVAL_POLICIES,
  DEFAULT_APPROVAL,
  DEFAULT_SANDBOX,
  SANDBOX_MODES,
} from './constants.ts';
import { backupNameOf } from './target.ts';
import type { CodexPermissionsValues, ProviderPermissionsTarget } from './types.ts';

/**
 * CODEX (`toml`) — два СКАЛЯРНЫХ ключа КОРНЯ `~/.codex/config.toml`:
 * `approval_policy` и `sandbox_mode`. ЗАПИСЬ ХИРУРГИЧЕСКАЯ
 * (`upsertCodexRootScalar` для каждого ключа): правится только корневой скаляр —
 * одноимённые ключи ВНУТРИ таблиц (`[profiles.x]` и т.п.) НЕ тронуты; таблицы,
 * комментарии, прочие корневые ключи — БАЙТ-В-БАЙТ.
 */

export function parseCodexDraft(rec: Record<string, unknown>): CodexPermissionDraft | undefined {
  const approvalPolicy = rec.approvalPolicy;
  const sandboxMode = rec.sandboxMode;
  if (
    typeof approvalPolicy !== 'string' ||
    !APPROVAL_POLICIES.includes(approvalPolicy as CodexApprovalPolicy)
  )
    return undefined;
  if (typeof sandboxMode !== 'string' || !SANDBOX_MODES.includes(sandboxMode as CodexSandboxMode))
    return undefined;
  return {
    approvalPolicy: approvalPolicy as CodexApprovalPolicy,
    sandboxMode: sandboxMode as CodexSandboxMode,
  };
}

/**
 * Прочитать текущие значения обоих ключей КОРНЯ. Отсутствует ключ → дефолт Codex
 * (НЕ пишем его — только показываем). Значение вне enum сохраняется как есть на
 * чтение (интерфейс покажет фактическое состояние), но помечает раздел не как
 * usingDefaults. Непарсящийся файл → fail-closed (бросает).
 */
export function readCodexPermissions(text: string): CodexPermissionsValues {
  if (!text.trim()) {
    return {
      kind: 'codex',
      approvalPolicy: DEFAULT_APPROVAL,
      sandboxMode: DEFAULT_SANDBOX,
      usingDefaults: true,
    };
  }
  const parsed = parseCodexToml(text);
  const rawApproval = parsed.approval_policy;
  const rawSandbox = parsed.sandbox_mode;

  const approvalPresent =
    typeof rawApproval === 'string' &&
    APPROVAL_POLICIES.includes(rawApproval as CodexApprovalPolicy);
  const sandboxPresent =
    typeof rawSandbox === 'string' && SANDBOX_MODES.includes(rawSandbox as CodexSandboxMode);

  return {
    kind: 'codex',
    approvalPolicy: approvalPresent ? (rawApproval as CodexApprovalPolicy) : DEFAULT_APPROVAL,
    sandboxMode: sandboxPresent ? (rawSandbox as CodexSandboxMode) : DEFAULT_SANDBOX,
    usingDefaults: rawApproval === undefined && rawSandbox === undefined,
  };
}

/**
 * Записать оба скалярных ключа КОРНЯ через `upsertCodexRootScalar`. Правится только
 * корневой скаляр — одноимённые ключи внутри таблиц (`[profiles.x]`) НЕ тронуты; всё
 * прочее байт-в-байт. Итог репарсится и сверяется с намерением — расхождение →
 * fail-closed (не пишем). Нет файла → создаётся только с этими двумя ключами.
 */
export function saveCodexPermissions(
  target: ProviderPermissionsTarget,
  draft: CodexPermissionDraft,
  backupDir: string | undefined,
): string | undefined {
  const exists = existsSync(target.filePath);
  const original = exists ? readFileSync(target.filePath, 'utf8') : '';

  // Оригинал обязан парситься (иначе не знаем структуру и границу корня) — fail-closed.
  if (original.trim()) parseCodexToml(original);

  let next = original.trim() ? original : '';
  next = upsertCodexRootScalar(next, 'approval_policy', draft.approvalPolicy);
  next = upsertCodexRootScalar(next, 'sandbox_mode', draft.sandboxMode);

  // Верификация: итог обязан валидно репарситься, а корневые значения — точно
  // совпадать с намерением. Иначе surgery что-то испортила → не пишем.
  const reparsed = parseCodexToml(next);
  if (
    reparsed.approval_policy !== draft.approvalPolicy ||
    reparsed.sandbox_mode !== draft.sandboxMode
  ) {
    throw new UnrecognizedFormatError();
  }

  // preserveForm:false — правится одна строка исходного текста (CRLF учтён в
  // upsertCodexRootScalar, BOM исходника цел); всё прочее байт-в-байт.
  return writeTextFile(target.filePath, next, {
    backupDir,
    backupName: backupNameOf(target),
    preserveForm: false,
  });
}
