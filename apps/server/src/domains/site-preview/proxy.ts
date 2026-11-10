import {
  createServer,
  request as upstreamRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { PICK_SCRIPT_PATH } from '@agentdeck/contracts/site-preview';
import { injectPickTag, isHtmlResponse } from './inject.ts';
import { pickScript } from './pick-script.ts';
import type { SiteProxy, SiteProxyOptions } from './site-preview.types.ts';

/** Слушаем только loopback: телефон и соседи по сети до прокси не достают (D20). */
export const SITE_PROXY_HOST = '127.0.0.1';

const DECODERS: Record<string, () => NodeJS.ReadWriteStream> = {
  gzip: createGunzip,
  deflate: createInflate,
  br: createBrotliDecompress,
};

/** Заголовки ответа, которые после вставки тега лгали бы: длина, сжатие, отпечаток тела. */
const BODY_BOUND = ['content-length', 'content-encoding', 'etag', 'transfer-encoding'];

/**
 * Прокси одного сайта (P173). Цель задана при старте и из запроса не берётся вовсе: запрос с
 * чужим `Host`, с абсолютным адресом (`GET http://…`) или `CONNECT` — 403, поэтому открытым
 * прокси он не станет и от подмены DNS (rebinding) закрыт. В разметку страницы вставляется
 * один тег скрипта выбора, остальные тела идут байт в байт; WebSocket (HMR) проходит насквозь.
 */
export async function startSiteProxy({ target, nonce }: SiteProxyOptions): Promise<SiteProxy> {
  const targetOrigin = `http://${target.host}:${target.port}`;
  const sockets = new Set<Duplex>();
  const script = pickScript(nonce);
  let port = 0;
  // Свои имена прокси: тот же порт под 127.0.0.1 и под localhost. Любое другое имя — отказ.
  const ownHosts = (): Set<string> => new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const ownOrigins = (): Set<string> => new Set([...ownHosts()].map((host) => `http://${host}`));

  const allowed = (req: IncomingMessage): boolean => {
    const host = req.headers.host?.toLowerCase();
    return host !== undefined && ownHosts().has(host) && (req.url ?? '').startsWith('/');
  };

  /** Заголовки запроса к цели: имя хоста цели, свой origin и referer — в origin цели. */
  const forwardHeaders = (req: IncomingMessage): OutgoingHttpHeaders => {
    const headers: OutgoingHttpHeaders = { ...req.headers, host: `${target.host}:${target.port}` };
    // Сжатое тело не вставить, не распаковав: просим цель без сжатия, распаковка — запасной путь.
    delete headers['accept-encoding'];
    const origin = req.headers.origin;
    if (origin && ownOrigins().has(origin)) headers.origin = targetOrigin;
    const referer = req.headers.referer;
    if (referer) {
      const own = [...ownOrigins()].find((o) => referer.startsWith(`${o}/`) || referer === o);
      if (own) headers.referer = `${targetOrigin}${referer.slice(own.length)}`;
    }
    return headers;
  };

  /** Заголовки ответа: редирект на цель — на себя, запрет рамки снят (окно панели и есть рамка). */
  const replyHeaders = (headers: IncomingHttpHeaders): OutgoingHttpHeaders => {
    const out: OutgoingHttpHeaders = { ...headers };
    delete out['x-frame-options'];
    const location = headers.location;
    if (location?.startsWith(targetOrigin)) {
      out.location = `http://${SITE_PROXY_HOST}:${port}${location.slice(targetOrigin.length)}`;
    }
    return out;
  };

  const sendHtml = (upstream: IncomingMessage, res: ServerResponse): void => {
    const encoding = String(upstream.headers['content-encoding'] ?? '').toLowerCase();
    const decoder = DECODERS[encoding];
    const body: Buffer[] = [];
    const source: NodeJS.ReadableStream = decoder ? upstream.pipe(decoder()) : upstream;
    source.on('data', (chunk: Buffer) => body.push(chunk));
    source.on('error', () => res.destroy());
    source.on('end', () => {
      // latin1: байт = символ, любая кодировка страницы переживает вставку ASCII-тега.
      const html = Buffer.from(injectPickTag(Buffer.concat(body).toString('latin1')), 'latin1');
      const headers = replyHeaders(upstream.headers);
      for (const name of BODY_BOUND) delete headers[name];
      headers['content-length'] = html.length;
      res.writeHead(upstream.statusCode ?? 502, headers);
      res.end(html);
    });
  };

  const server = createServer((req, res) => {
    if (!allowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }
    if (req.method === 'GET' && req.url?.split('?')[0] === PICK_SCRIPT_PATH) {
      res
        .writeHead(200, {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'no-store',
        })
        .end(script);
      return;
    }
    const outgoing = upstreamRequest(
      {
        host: target.host,
        port: target.port,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req),
      },
      (upstream) => {
        const status = upstream.statusCode ?? 502;
        const hasBody = req.method !== 'HEAD' && status !== 204 && status !== 304;
        if (hasBody && isHtmlResponse(upstream.headers['content-type'])) {
          sendHtml(upstream, res);
          return;
        }
        res.writeHead(status, replyHeaders(upstream.headers));
        upstream.pipe(res);
      },
    );
    outgoing.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }).end('bad gateway');
      else res.destroy();
    });
    req.pipe(outgoing);
  });

  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  // CONNECT — просьба туннеля к произвольному адресу: такого прокси здесь нет.
  server.on('connect', (_req: IncomingMessage, socket: Duplex) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = req.headers.origin;
    // WebSocket не подчиняется CORS: чужая страница браузера открыла бы его к прокси, поэтому
    // origin, если он есть, обязан быть своим.
    if (!allowed(req) || (origin !== undefined && !ownOrigins().has(origin))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const outgoing = upstreamRequest({
      host: target.host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req),
    });
    outgoing.on('upgrade', (res: IncomingMessage, upstream: Duplex, upstreamHead: Buffer) => {
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      const lines = [`HTTP/1.1 101 ${res.statusMessage ?? 'Switching Protocols'}`];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        lines.push(`${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}`);
      }
      socket.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (upstreamHead.length > 0) socket.write(upstreamHead);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      const drop = (): void => {
        upstream.destroy();
        socket.destroy();
      };
      upstream.on('error', drop);
      socket.on('error', drop);
      upstream.on('close', drop);
      socket.on('close', drop);
    });
    outgoing.on('response', (res: IncomingMessage) => {
      res.resume();
      socket.end(`HTTP/1.1 ${res.statusCode ?? 502} ${res.statusMessage ?? ''}\r\n\r\n`);
    });
    outgoing.on('error', () => socket.destroy());
    outgoing.end();
  });

  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, SITE_PROXY_HOST, () => {
      server.off('error', fail);
      done();
    });
  });
  const address = server.address() as AddressInfo;
  port = address.port;

  return {
    port,
    address: address.address,
    origin: `http://${SITE_PROXY_HOST}:${port}`,
    close: () =>
      new Promise<void>((done) => {
        // Открытые соединения (keep-alive, WebSocket HMR) держали бы порт: гасим их сами.
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => done());
      }),
  };
}
