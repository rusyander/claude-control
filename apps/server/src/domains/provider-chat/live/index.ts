import type { ConfigProvider } from '../../../providers/types.ts';
import { CodexAppServerTurn } from './codex-app-server.ts';
import { GooseAcpTurn } from './goose-acp.ts';
import { KimiServerTurn } from './kimi-server.ts';
import { QwenServeTurn } from './qwen-serve.ts';
import type { LiveTurn } from './types.ts';

/** Живой ход под протокол из каталога провайдера; неизвестный — `undefined`. */
export function createLiveTurn(
  kind: NonNullable<ConfigProvider['assistant']>['liveServer'],
): LiveTurn | undefined {
  if (kind === 'codex-app-server') return new CodexAppServerTurn();
  if (kind === 'qwen-serve') return new QwenServeTurn();
  if (kind === 'goose-acp') return new GooseAcpTurn();
  if (kind === 'kimi-server') return new KimiServerTurn();
  return undefined;
}
