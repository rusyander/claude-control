/**
 * Сторож панели называет ядру звенья пересылки (P131, 07:69-71): pid сервера панели и Vite,
 * которым ядро разрешит ставить заголовок `x-agentdeck-peer-pid`. Пишут его `dev-watch.mjs`
 * (сразу после запуска сервера и каждому ядру, поднятому позже), `tools/keepalive.mjs` (после
 * подъёма половин стенда) и стенд QA с ядром (`startStand({core})`) — тем же `watchHops`. Без
 * записи команда, пришедшая через панель, у ядра — пир без доверия, и строгая команда требует
 * подписи устройства.
 *
 * Итог записи сторож кладёт в файл (`AGENTDECK_HOP_RECORD` в окружении сервера панели):
 * прокладка ждёт его, прежде чем переслать команду ядру, — иначе первая команда обгоняла
 * запись (гонка запуска) и получала отказ, хотя звено вот-вот будет записано.
 *
 * Голый Node без strip-types (сторожа исполняются так), поэтому протокол канала надзора
 * повторён здесь, а не импортирован: ядро и панель кода друг друга не тянут. Сторона ядра —
 * `apps/core/src/platform/supervisor-channel.ts`; их совместимость держит интеграционный тест
 * P131, где этот модуль говорит с настоящим ядром.
 *
 * Токен (`<дом ядра>/supervisor-token`) по каналу не ходит: клиент доказывает его знание
 * HMAC над числом ядра и не верит ответу, пока ядро не докажет то же над числом клиента.
 */
/* global process, setTimeout, clearTimeout, setInterval, clearInterval, Buffer */
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CORE_HOME_ENV = 'AGENTDECK_CORE_HOME';
/** Файл итога записи звеньев: сторож пишет, прокладка сервера панели ждёт его перед командой. */
export const HOP_RECORD_ENV = 'AGENTDECK_HOP_RECORD';
const TOKEN_FILE = 'supervisor-token';
const TIMEOUT_MS = 5_000;
const MAX_LINE = 64 * 1024;

/** Дом ядра — то же правило, что у ядра и прокладки панели. */
export function coreHomeOf(env = process.env) {
  const override = env[CORE_HOME_ENV];
  if (override && override.trim() !== '') return resolve(override);
  return join(homedir(), '.agentdeck', 'core');
}

const proofOf = (token, parts) =>
  createHmac('sha256', token).update(parts.join('\n')).digest('hex');

function sameProof(given, want) {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Кто слушает порт, или 0. Без слова состояния (`LISTENING` переводится вместе с Windows):
 * строка слушателя в `netstat -ano` — та, у которой удалённый адрес нулевой.
 */
export function listenerPid(port, platform = process.platform, exec = execFileSync) {
  try {
    if (platform === 'win32') {
      const netstat = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'netstat.exe');
      const out = exec(netstat, ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
      for (const line of String(out).split(/\r?\n/)) {
        const match = line
          .trim()
          .match(/^TCP\s+\S+:(\d+)\s+(?:0\.0\.0\.0|\[::\]|\*):0\s+\S+\s+(\d+)$/i);
        if (match && Number(match[1]) === port) return Number(match[2]);
      }
      return 0;
    }
    const out = exec('lsof', ['-nP', '-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    return Number(String(out).split(/\s+/).filter(Boolean)[0]) || 0;
  } catch {
    // Слушателя нет либо утилиты нет — записывать нечего.
    return 0;
  }
}

/** Пути каналов надзора живых строк ядра в `procs.json`. */
export function supervisorsOf(coreHome) {
  try {
    const procs = JSON.parse(readFileSync(join(coreHome, 'procs.json'), 'utf8'));
    const cores = Array.isArray(procs?.cores) ? procs.cores : [];
    return cores.flatMap((row) =>
      typeof row?.supervisor === 'string' && row.supervisor ? [row.supervisor] : [],
    );
  } catch {
    return [];
  }
}

/** Одна просьба `hops.set` по каналу: ответ ядра, доказанный тем же токеном, или причина. */
function ask(path, token, pids) {
  return new Promise((done) => {
    const socket = connect(path);
    const nonce = randomBytes(16).toString('hex');
    let buffer = '';
    let stage = 'hello';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    const timer = setTimeout(() => finish({ ok: false, code: 'timeout' }), TIMEOUT_MS);
    socket.setEncoding('utf8');
    socket.on('error', (error) =>
      finish({ ok: false, code: 'unreachable', detail: error.message }),
    );
    socket.on('close', () => finish({ ok: false, code: 'closed' }));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) return finish({ ok: false, code: 'too-long' });
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return finish({ ok: false, code: 'bad-reply' });
        }
        if (stage === 'hello') {
          if (typeof message?.hello !== 'string') return finish({ ok: false, code: 'bad-hello' });
          stage = 'reply';
          const proof = proofOf(token, ['hops.set', message.hello, nonce, pids.join(',')]);
          socket.write(`${JSON.stringify({ op: 'hops.set', hops: pids, nonce, proof })}\n`);
          continue;
        }
        // Ответ без доказательства — не от ядра (имя канала мог занять кто угодно).
        const body = typeof message?.body === 'string' ? message.body : '';
        if (!sameProof(message?.proof, proofOf(token, ['reply', nonce, body])))
          return finish({ ok: false, code: 'unproven-reply' });
        try {
          return finish(JSON.parse(body));
        } catch {
          return finish({ ok: false, code: 'bad-reply' });
        }
      }
    });
  });
}

/**
 * Записать звенья у каждого ядра этого дома (P83: сборок может быть несколько). `pids` без
 * нулей и повторов; пустой набор тоже записывается — он снимает прежние звенья.
 * Ответ — по ядру: `{ channel, ok, accepted?, refused?, code? }`.
 */
export async function recordHops({ coreHome = coreHomeOf(), pids, channels }) {
  const clean = [...new Set(pids.filter((pid) => Number.isInteger(pid) && pid > 0))];
  let token;
  try {
    token = readFileSync(join(coreHome, TOKEN_FILE), 'utf8').trim();
  } catch {
    return [];
  }
  if (!token) return [];
  const results = [];
  for (const channel of channels ?? supervisorsOf(coreHome)) {
    results.push({ channel, ...(await ask(channel, token, clean)) });
  }
  return results;
}

/** Строка журнала сторожа об исходе записи; пустая — ядра нет, писать некому. */
export function describeRecord(results, pids) {
  if (results.length === 0) return '';
  return results
    .map((r) =>
      r.ok
        ? `звенья ядру записаны: ${r.accepted.join(', ') || 'нет'}${
            r.refused?.length
              ? `; отказ ${r.refused.map((x) => `${x.pid} (${x.reason})`).join(', ')}`
              : ''
          }`
        : `звенья ${pids.join(', ')} ядру не записаны: ${r.code}${r.detail ? ` ${r.detail}` : ''}`,
    )
    .join('; ');
}

/**
 * Файл итога: `{ v, pids, channels: { <канал>: ответ ядра } }`. Пишется целиком без
 * переименования: читатель, поймавший недописанный файл, просто ждёт следующего опроса.
 */
export function writeHopRecord(file, pids, channels) {
  try {
    writeFileSync(file, `${JSON.stringify({ v: 1, pids, channels })}\n`);
  } catch {
    // Каталог сторожа исчез — прокладка дождётся своего срока и перешлёт без ожидания.
  }
}

export function readHopRecord(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw?.v !== 1 || !Array.isArray(raw.pids) || typeof raw.channels !== 'object') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * Записан ли `pid` ядру с каналом `channel` по файлу итога: `recorded` — ядро приняло звено,
 * `refused` — запись была и не прошла (ждать нечего), `pending` — записи для этого pid и канала
 * ещё нет.
 */
export function hopVerdictOf(record, channel, pid) {
  if (!record || !record.pids.includes(pid)) return 'pending';
  const reply = record.channels[channel];
  if (!reply) return 'pending';
  if (reply.ok !== true) return 'refused';
  return Array.isArray(reply.accepted) && reply.accepted.includes(pid) ? 'recorded' : 'refused';
}

/**
 * Надзор звеньев на всё время жизни сторожа: записать `pidsOf()` каждому ядру этого дома сейчас
 * и каждому ядру, которое поднимется позже (новая строка с каналом в `procs.json` — ядро,
 * запущенное после панели, или перезапуск ядра: его набор звеньев пуст). `refresh()` — звенья
 * сменились (сторож поднял новый сервер): запись заново всем ядрам. Итог — в `file`, если задан.
 */
export function watchHops({
  coreHome = coreHomeOf(),
  pidsOf,
  file,
  everyMs = 1_000,
  onRecord = () => {},
}) {
  let pids = [];
  let done = {};
  let generation = 0;
  let running = Promise.resolve();

  const tick = (fresh) => {
    running = running.then(async () => {
      if (fresh) {
        generation += 1;
        pids = [...new Set(pidsOf().filter((pid) => Number.isInteger(pid) && pid > 0))];
        done = {};
        if (file) writeHopRecord(file, pids, done);
      }
      const mine = generation;
      const live = supervisorsOf(coreHome);
      // Канал ушедшего ядра из итога выпадает: его ответ к новому ядру не относится.
      for (const channel of Object.keys(done)) if (!live.includes(channel)) delete done[channel];
      const todo = live.filter((channel) => !done[channel]);
      if (todo.length === 0 || pids.length === 0) {
        if (file && fresh) writeHopRecord(file, pids, done);
        return;
      }
      const results = await recordHops({ coreHome, pids, channels: todo });
      if (mine !== generation) return;
      for (const result of results) {
        const { channel, ...reply } = result;
        // Канал без ответа (ядро ещё поднимается) — повтор на следующем опросе.
        if (reply.ok || reply.code !== 'unreachable') done[channel] = reply;
      }
      if (file) writeHopRecord(file, pids, done);
      onRecord(results, pids);
    });
    // Сбой одного опроса не рвёт очередь: следующий опрос пойдёт своим чередом.
    running = running.catch(() => {});
    return running;
  };

  const timer = setInterval(() => void tick(false), everyMs);
  timer.unref?.();
  return {
    refresh: () => tick(true),
    stop: () => clearInterval(timer),
  };
}

// Запуск из командной строки: `node hop-recorder.mjs <pid>…` — ручная запись (и проверка
// канала) без сторожа; ответ ядра — в stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pids = process.argv.slice(2).map(Number);
  recordHops({ pids }).then((results) => {
    process.stdout.write(`${JSON.stringify(results)}\n`);
    process.exitCode = results.length > 0 && results.every((r) => r.ok) ? 0 : 1;
  });
}
