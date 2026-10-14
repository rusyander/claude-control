import {
  LOCAL_MCP_MIN_HEADROOM_TOKENS,
  localMcpFits,
  type LocalMcpInfo,
  type LocalMcpServer,
} from '@agentdeck/contracts/local-models';

/** Строка списка: сервер и можно ли его взять (после него остаётся не меньше минимума окна). */
export interface LocalMcpRow {
  server: LocalMcpServer;
  /** Уже взятый можно снять всегда; невзятый — только пока он влезает. */
  canPick: boolean;
}

export function localMcpRows(info: LocalMcpInfo): LocalMcpRow[] {
  return info.servers.map((server) => ({
    server,
    canPick: server.picked || localMcpFits(info, info.picked, server.id),
  }));
}

/** Запас окна на разговор ниже минимума: сжатие истории пойдёт на каждом ходу. */
export function localMcpTight(info: Pick<LocalMcpInfo, 'headroom'>): boolean {
  return info.headroom < LOCAL_MCP_MIN_HEADROOM_TOKENS;
}

/** Серверы без цены и без названной причины — их ещё не пытались замерить. */
export function localMcpUnmeasured(info: Pick<LocalMcpInfo, 'servers'>): string[] {
  return info.servers
    .filter((server) => server.tokens === null && !server.error)
    .map((server) => server.id);
}
