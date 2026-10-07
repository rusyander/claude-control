/**
 * Сетевая граница для CLI, у которого адрес модели не подменить ни флагом, ни
 * файлом: одноразовый удостоверяющий центр и прокси, который принимает CONNECT
 * к разрешённым хостам, сам завершает TLS их сертификатом и отдаёт запрос
 * обработчику проверки. Остальные CONNECT получают 403 — из проверки ничего не
 * уходит в сеть, даже фоновые походы CLI.
 *
 * Зачем: агент панели на Codex запускается с `--ignore-user-config` — ни
 * провайдер модели из `config.toml`, ни проектный `.codex/config.toml` (он не
 * доверен: доверие живёт в том же отключённом пользовательском конфиге) до хода
 * не доходят. Остаются переменные окружения, которые панель передаёт CLI по
 * списку (`HTTPS_PROXY`, `SSL_CERT_FILE`): ими Codex и уводится сюда, а запуск
 * панели остаётся ровно тем, что получит человек.
 *
 * Сертификаты строятся здесь же, DER вручную: внешний openssl или пакет
 * сертификатов сделали бы проверку зависимой от машины, на которой её гоняют.
 */
import { X509Certificate, createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';

// ── DER ────────────────────────────────────────────────────────────────────
function len(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
function oid(text) {
  const [a, b, ...rest] = text.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const value of rest) {
    const chunk = [value & 0x7f];
    for (let v = value >> 7; v > 0; v >>= 7) chunk.unshift(0x80 | (v & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}
const utf8 = (text) => tlv(0x0c, Buffer.from(text, 'utf8'));
const octets = (buf) => tlv(0x04, buf);
const bits = (buf) => tlv(0x03, Buffer.from([0]), buf);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0]));
function utcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  const text = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(text, 'ascii'));
}
const name = (cn) => seq(set(seq(oid('2.5.4.3'), utf8(cn))));
const ext = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));

const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

function certificate({ subject, issuer, publicKey, signerKey, extensions }) {
  const serial = randomBytes(16);
  serial[0] &= 0x7f; // положительное число
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ECDSA_SHA256,
    name(issuer),
    seq(utcTime(new Date(now - 3_600_000)), utcTime(new Date(now + 2 * 86_400_000))),
    name(subject),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...extensions)),
  );
  const der = seq(tbs, ECDSA_SHA256, bits(sign('sha256', tbs, signerKey)));
  const body = der.toString('base64').replace(/.{64}/g, '$&\n');
  return `-----BEGIN CERTIFICATE-----\n${body.trim()}\n-----END CERTIFICATE-----\n`;
}

/**
 * Одноразовый центр и сертификат сервера для `hosts`. Ключи живут только в
 * памяти процесса проверки; на диск ложится лишь открытый сертификат центра.
 */
export function makeTestCa(hosts) {
  const ca = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const caName = `agentdeck-qa-ca-${randomBytes(4).toString('hex')}`;
  const caPem = certificate({
    subject: caName,
    issuer: caName,
    publicKey: ca.publicKey,
    signerKey: ca.privateKey,
    extensions: [
      ext('2.5.29.19', true, seq(bool(true))),
      ext('2.5.29.15', true, bits(Buffer.from([0x06]))),
    ],
  });
  const leaf = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const leafPem = certificate({
    subject: hosts[0],
    issuer: caName,
    publicKey: leaf.publicKey,
    signerKey: ca.privateKey,
    extensions: [
      ext('2.5.29.19', true, seq()),
      ext('2.5.29.15', true, bits(Buffer.from([0x80]))),
      ext('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))),
      ext('2.5.29.17', false, seq(...hosts.map((host) => tlv(0x82, Buffer.from(host, 'ascii'))))),
    ],
  });
  // Самопроверка: сертификат, который не сошёлся бы здесь, CLI отверг бы молча —
  // и проверка искала бы дефект не там.
  const caCert = new X509Certificate(caPem);
  const leafCert = new X509Certificate(leafPem);
  if (
    !caCert.verify(ca.publicKey) ||
    !leafCert.verify(ca.publicKey) ||
    !leafCert.checkHost(hosts[0])
  )
    throw new Error('одноразовый сертификат не сошёлся сам с собой');
  return {
    caPem,
    leafPem,
    leafKeyPem: leaf.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    fingerprint: createHash('sha256').update(caCert.raw).digest('hex').slice(0, 16),
  };
}

/**
 * Прокси CONNECT на 127.0.0.1:<свободный порт>. Разрешённые хосты — TLS
 * завершается здесь, запрос уходит в `handler(req, res, body)`; апгрейд до
 * WebSocket — `onUpgrade` (по умолчанию 426: CLI переходит на обычный HTTP).
 * Все прочие CONNECT — 403 и запись в `refused`.
 */
export async function startInterceptProxy({ hosts, tls, handler, onUpgrade }) {
  const connects = [];
  const refused = [];
  const inner = createHttpsServer(
    { key: tls.leafKeyPem, cert: tls.leafPem, ALPNProtocols: ['http/1.1'] },
    (req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
    },
  );
  inner.on('upgrade', (req, socket) => {
    if (onUpgrade) return onUpgrade(req, socket);
    socket.end('HTTP/1.1 426 Upgrade Required\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
  });
  inner.on('tlsClientError', () => {});
  const outer = createHttpServer((req, res) => {
    // Обычный HTTP через прокси (не CONNECT) — проверке он не нужен.
    refused.push(`${req.method} ${req.url}`);
    res.writeHead(403).end();
  });
  outer.on('connect', (req, socket) => {
    const host = String(req.url).replace(/:\d+$/, '');
    socket.on('error', () => {});
    if (!hosts.includes(host)) {
      refused.push(req.url);
      socket.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
      return;
    }
    connects.push(req.url);
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () =>
      inner.emit('connection', socket),
    );
  });
  await new Promise((done) => outer.listen(0, '127.0.0.1', done));
  return {
    url: `http://127.0.0.1:${outer.address().port}`,
    connects,
    refused,
    close: () =>
      new Promise((done) => {
        outer.closeAllConnections?.();
        inner.closeAllConnections?.();
        inner.close();
        outer.close(() => done());
      }),
  };
}
