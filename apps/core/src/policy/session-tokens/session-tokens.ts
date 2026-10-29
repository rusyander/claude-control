import { createHmac, timingSafeEqual } from 'node:crypto';
import { isUuidv7 } from '@agentdeck/contracts/core/ids';

/**
 * Токен сессии (03 §Launcher, 06 §Authority): `AGENTDECK_SESSION_TOKEN` открывает сессии только
 * инструменты модели и чтение своего шага; человека он не доказывает никогда.
 *
 * Токен выводится из ключа ядра (HMAC от `taskId.sessionId`), а не хранится: сессия переживает
 * смерть ядра (01 §Sessions at core death), и её мост MCP должен говорить с новым ядром тем же
 * токеном — без файла токенов, который пришлось бы беречь и чистить. Подделать токен чужой
 * сессии без ключа нельзя; кончилась ли сессия — решает журнал (состояние сессии), а не токен.
 */

const PREFIX = 'ads1';

export interface SessionTokenClaim {
  taskId: string;
  sessionId: string;
}

export interface SessionTokens {
  mint(claim: SessionTokenClaim): string;
  /** Токен этого ядра с верной подписью → чья сессия; иначе `undefined`. */
  verify(token: string): SessionTokenClaim | undefined;
}

export function createSessionTokens(key: string): SessionTokens {
  if (key.length < 16) throw new Error('session token key too short');
  const mac = (taskId: string, sessionId: string): Buffer =>
    createHmac('sha256', key).update(`${PREFIX}.${taskId}.${sessionId}`).digest();
  return {
    mint({ taskId, sessionId }) {
      if (!isUuidv7(taskId) || !isUuidv7(sessionId)) throw new Error('ids must be UUIDv7');
      return `${PREFIX}.${taskId}.${sessionId}.${mac(taskId, sessionId).toString('base64url')}`;
    },
    verify(token) {
      const parts = token.split('.');
      if (parts.length !== 4 || parts[0] !== PREFIX) return undefined;
      const [, taskId = '', sessionId = '', sig = ''] = parts;
      if (!isUuidv7(taskId) || !isUuidv7(sessionId)) return undefined;
      const got = Buffer.from(sig, 'base64url');
      const want = mac(taskId, sessionId);
      if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
      return { taskId, sessionId };
    },
  };
}
