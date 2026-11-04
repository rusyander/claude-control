import type { CodexPermissionDraft } from '../provider-permissions.ts';
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from '../vocabulary.ts';

/** Разобрать черновик прав Codex: оба корневых скаляра строго из своих наборов. */
export function parseCodexDraft(rec: Record<string, unknown>): CodexPermissionDraft | undefined {
  const approvalPolicy = rec.approvalPolicy;
  const sandboxMode = rec.sandboxMode;
  if (
    typeof approvalPolicy !== 'string' ||
    !(CODEX_APPROVAL_POLICIES as readonly string[]).includes(approvalPolicy)
  )
    return undefined;
  if (
    typeof sandboxMode !== 'string' ||
    !(CODEX_SANDBOX_MODES as readonly string[]).includes(sandboxMode)
  )
    return undefined;
  return {
    approvalPolicy: approvalPolicy as CodexApprovalPolicy,
    sandboxMode: sandboxMode as CodexSandboxMode,
  };
}
