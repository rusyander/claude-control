import { request } from 'node:http';
import { connect } from 'node:net';

/**
 * Сетевые пробы стенда и сервисов (04:75-77, 04:124): открыт ли порт, чем отвечает адрес
 * здоровья. Сетевой вызов — дело платформы (P44): решение видит только исход. Ошибка соединения
 * и таймаут — исключение, читатель превращает его в `unknown`, а не в «нет».
 */

/** TCP-порт принимает соединение (сервис поднялся). Отказ / таймаут — `false` с причиной. */
export function tcpOpen(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ open: true } | { open: false; reason: string }> {
  return new Promise((done) => {
    const socket = connect({ host, port });
    const finish = (out: { open: true } | { open: false; reason: string }): void => {
      socket.destroy();
      done(out);
    };
    socket.setTimeout(timeoutMs, () => finish({ open: false, reason: `timeout ${timeoutMs} ms` }));
    socket.once('connect', () => finish({ open: true }));
    socket.once('error', (error) => finish({ open: false, reason: error.message }));
  });
}

/**
 * Код ответа GET по адресу здоровья. Тело не читается дальше предела (чужой процесс на порте не
 * раздует память). Нет ответа — исключение.
 */
export function httpStatus(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      let seen = 0;
      res.on('data', (chunk: Buffer) => {
        seen += chunk.length;
        if (seen > 64 * 1024) res.destroy();
      });
      res.on('close', () => resolve(res.statusCode ?? 0));
      res.on('error', () => resolve(res.statusCode ?? 0));
    });
    req.on('timeout', () => req.destroy(new Error(`timeout after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}
