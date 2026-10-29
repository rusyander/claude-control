// Инструмент миграций проекта в миниатюре (P84): читает DATABASE_URL из `.env` текущей папки
// (как dbmate / prisma / knex) и шлёт SQL-файл по протоколу Postgres. Своего адреса у него нет —
// куда он постучится, решает только переписанный `.env` копии. Вход только trust (контейнер
// задачи без пароля); иначе — выход 3 с причиной.
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const sqlFile = process.argv[2];
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split(/\r?\n/)
    .map((l) => /^\s*([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim().replace(/^(['"])(.*)\1$/, '$2')]),
);
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL missing in .env');
  process.exit(2);
}
const url = new URL(env.DATABASE_URL);
const user = decodeURIComponent(url.username || 'postgres');
const db = url.pathname.slice(1) || user;

const cstr = (s) => Buffer.from(`${s}\0`, 'utf8');
function startup() {
  const body = Buffer.concat([
    cstr('user'),
    cstr(user),
    cstr('database'),
    cstr(db),
    Buffer.from([0]),
  ]);
  const head = Buffer.alloc(8);
  head.writeInt32BE(8 + body.length, 0);
  head.writeInt32BE(196608, 4);
  return Buffer.concat([head, body]);
}
function msg(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'latin1');
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
}

const sock = connect({ host: url.hostname, port: Number(url.port || 5432) });
const timer = setTimeout(() => {
  console.error('timeout');
  process.exit(4);
}, 20_000);
let buf = Buffer.alloc(0);
let sent = false;
sock.on('error', (e) => {
  console.error(`connect ${url.hostname}:${url.port}: ${e.message}`);
  process.exit(5);
});
sock.on('connect', () => sock.write(startup()));
sock.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 5) {
    const type = String.fromCharCode(buf[0]);
    const len = buf.readInt32BE(1);
    if (buf.length < 1 + len) return;
    const body = buf.subarray(5, 1 + len);
    buf = buf.subarray(1 + len);
    if (type === 'R' && body.readInt32BE(0) !== 0) {
      console.error(`auth method ${body.readInt32BE(0)} not supported`);
      process.exit(3);
    }
    if (type === 'E') {
      console.error(`server error: ${body.toString('utf8').replace(/\0/g, ' ').trim()}`);
      process.exit(1);
    }
    if (type === 'Z' && !sent) {
      sent = true;
      sock.write(msg('Q', cstr(readFileSync(sqlFile, 'utf8'))));
    } else if (type === 'Z') {
      sock.end(msg('X', Buffer.alloc(0)));
      clearTimeout(timer);
      console.log(`migrated ${url.hostname}:${url.port}/${db}`);
    }
  }
});
