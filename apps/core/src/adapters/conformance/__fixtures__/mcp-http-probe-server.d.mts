/** Типы подставного удалённого сервера MCP (`mcp-http-probe-server.mjs`, s10 p9). */
export interface HttpProbe {
  /** `http://127.0.0.1:<port>/mcp`. */
  url: string;
  port: number;
  close(): Promise<void>;
}

export function startHttpProbe(options: {
  /** Журнал строк JSON: start / rpc (имена заголовков + auth) / call. */
  log: string;
  tool: string;
  /** Заголовки, чьи значения сервер сверяет сам; в журнал — только `auth: true|false`. */
  expectHeaders?: Record<string, string>;
}): Promise<HttpProbe>;
