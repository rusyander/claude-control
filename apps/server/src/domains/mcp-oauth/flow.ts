import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { McpServer } from '@claude-control/contracts';
import { createNetworkTransport, type NetworkTransport } from '../mcp-client.ts';
import { oauthCallbackUrl } from './callback.ts';
import { PanelOAuthProvider } from './provider.ts';
import { oauthStorePath } from './store.ts';

/**
 * Интерактивный вход: старт (получить адрес авторизации) и завершение (обменять
 * код на токены). Сам протокол ведёт официальный SDK — обнаружение сервера
 * авторизации (RFC 9728 / 8414), динамическую регистрацию клиента (RFC 7591),
 * PKCE и обновление токена он делает внутри `auth()`.
 */

// Тот же билдер, что у проверки связи и песочницы (`mcp-client.ts`): разбор
// url/headers/SSE-подписки один на всех, чтобы вход и health-check не разъехались.
type OAuthTransport = NetworkTransport;

/** Живые входы между стартом (редирект выдан) и callback (пришёл код). */
interface PendingFlow {
  serverId: string;
  transport: OAuthTransport;
  client: Client;
  createdAt: number;
}

const pending = new Map<string, PendingFlow>();
const FLOW_TTL_MS = 10 * 60 * 1000;

function sweepFlows(): void {
  const now = Date.now();
  for (const [state, flow] of pending) {
    if (now - flow.createdAt > FLOW_TTL_MS) {
      pending.delete(state);
      void flow.client.close().catch(() => undefined);
    }
  }
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

export type StartOAuthResult =
  { status: 'authorized' } | { status: 'redirect'; authorizationUrl: string };

/**
 * Начинает вход. Подключается к серверу с провайдером: если токены уже есть и
 * годны — подключение проходит, возвращаем `authorized`. Если нет — SDK
 * выстраивает адрес авторизации, кладёт его в провайдер и бросает
 * `UnauthorizedError`; тогда запоминаем незавершённый вход и отдаём адрес,
 * на который надо отправить пользователя.
 */
export async function startOAuth(server: McpServer, appData: string): Promise<StartOAuthResult> {
  if (server.transport === 'stdio') {
    throw new Error('OAuth доступен только у сетевых серверов (http/sse)');
  }
  sweepFlows();

  const provider = new PanelOAuthProvider(server.id, oauthStorePath(appData), oauthCallbackUrl());
  const transport = createNetworkTransport(server, provider);
  const client = new Client({ name: 'claude-control', version: '0.1.0' }, { capabilities: {} });

  try {
    await withDeadline(client.connect(transport), 20_000, 'Сервер не ответил вовремя');
    // Токены уже были и подошли — вход не требуется.
    await client.close().catch(() => undefined);
    return { status: 'authorized' };
  } catch (error) {
    if (error instanceof UnauthorizedError && provider.authorizationUrl) {
      pending.set(provider.pendingState, {
        serverId: server.id,
        transport,
        client,
        createdAt: Date.now(),
      });
      return { status: 'redirect', authorizationUrl: provider.authorizationUrl.toString() };
    }
    await client.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Завершает вход: по state находит незавершённый вход, отдаёт SDK код — тот
 * меняет его на токены и сохраняет их через провайдер. State мы сгенерировали
 * сами и по нему же ищем — подделать чужой вход нельзя.
 */
export async function finishOAuth(state: string, code: string): Promise<{ serverId: string }> {
  const flow = pending.get(state);
  if (!flow) throw new Error('Сессия авторизации не найдена или истекла');
  pending.delete(state);

  try {
    await flow.transport.finishAuth(code);
    return { serverId: flow.serverId };
  } finally {
    await flow.client.close().catch(() => undefined);
  }
}
