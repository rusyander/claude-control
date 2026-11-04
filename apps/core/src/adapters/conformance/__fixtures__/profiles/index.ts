import { CLAUDE_PROFILE } from './claude.ts';
import { CODEX_PROFILE } from './codex.ts';
import { GOOSE_PROFILE } from './goose.ts';
import { OPENCODE_PROFILE } from './opencode.ts';
import type { Profile } from './profile.types.ts';
import { QWEN_PROFILE } from './qwen.ts';
import type { RpcProfile } from './rpc-profile.types.ts';

/**
 * Профили набора соответствия, по одному на построенный переходник. Заготовки (`built: false`)
 * профиля не имеют: набор проверяет, что у них нет ни одной возможности и запуск отказан.
 */
export const PROFILES: readonly Profile[] = [CLAUDE_PROFILE, QWEN_PROFILE];

/** Переходники JSON-RPC по stdio — свой набор (`rpc.conformance.test.ts`), своя форма профиля. */
export const RPC_PROFILES: readonly RpcProfile[] = [CODEX_PROFILE, GOOSE_PROFILE, OPENCODE_PROFILE];

export type { Profile } from './profile.types.ts';
export type { RpcProfile } from './rpc-profile.types.ts';
export { after, ENDPOINT } from './shared.ts';
