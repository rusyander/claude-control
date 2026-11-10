/**
 * Поддельный dev-сервер для окна сайта (P173, P174): разметка с двумя одинаковыми кнопками (у
 * второй — вставленный секрет и разметка длиннее 4 КБ), JS со строкой `<head>` внутри (вставка
 * в JS была бы видна), сжатая разметка, редирект на себя, WebSocket-эхо (как HMR) и `/die` —
 * процесс падает сам. Адрес печатает строкой Vite: так его находит реестр запусков.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// Секрет собирается при запуске: в исходнике нет строки, похожей на ключ.
const SECRET = ['sk', 'plantedStandSecret0042'].join('-');
const BLOB = 'x'.repeat(5000);

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Stand site</title></head>
<body>
<main>
<h1>Stand site</h1>
<section class="cards">
<button class="buy" type="button">Buy now</button>
<button class="buy" type="button" data-token="${SECRET}" data-blob="${BLOB}">Pay for the order</button>
</section>
<p id="clicks">clicks: 0</p>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

const APP_JS = `const marker = '<head></head>';
let clicks = 0;
for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => {
  clicks += 1;
  document.getElementById('clicks').textContent = 'clicks: ' + clicks;
});
window.__appLoaded = marker.length;
`;

function wsAccept(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

/** Эхо текстовых кадров WebSocket: короткие кадры, маска клиента снимается. */
function echo(socket) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        socket.destroy();
        return;
      }
      const masked = (buf[1] & 0x80) !== 0;
      const maskAt = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i += 1) payload[i] ^= buf[maskAt + (i % 4)];
      buf = buf.subarray(off + len);
      if (opcode === 8) {
        socket.end(Buffer.from([0x88, 0]));
        return;
      }
      if (opcode !== 1) continue;
      const head =
        len < 126 ? Buffer.from([0x81, len]) : Buffer.from([0x81, 126, len >> 8, len & 255]);
      socket.write(Buffer.concat([head, payload]));
    }
  });
}

const server = http.createServer((req, res) => {
  const seen = { host: req.headers.host, encoding: req.headers['accept-encoding'] ?? null };
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' });
    res.end(PAGE);
  } else if (req.url === '/app.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(APP_JS);
  } else if (req.url === '/gz') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync('<html><body>gz page</body></html>'));
  } else if (req.url === '/redirect') {
    res.writeHead(302, { location: `http://localhost:${server.address().port}/` });
    res.end();
  } else if (req.url === '/seen') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(seen));
  } else if (req.url === '/die') {
    res.end('bye');
    setTimeout(() => process.exit(3), 50);
  } else {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.on('upgrade', (req, socket) => {
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${wsAccept(req.headers['sec-websocket-key'])}\r\n\r\n`,
  );
  echo(socket);
});

const port = Number(process.env.PORT || 0);
server.listen(port, '127.0.0.1', () => {
  console.log(`  Local:   http://localhost:${server.address().port}/`);
});
