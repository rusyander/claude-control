/**
 * Хук очереди тяжёлых шагов групп разделения (3.2 плана экономии, 17.10.2026).
 *
 * Четыре группы гоняли полные гейты и сборки одновременно: тесты падали по
 * таймауту, гейт повторялся (до четырёх полных прогонов в чате), агент сам
 * гасил dev-сервер «из-за нагрузки». Хук держит общую на машину очередь: перед
 * тяжёлой командой (`PreToolUse`, Bash) он ждёт свободного места и берёт
 * аренду, после неё (`PostToolUse` / `PostToolUseFailure`) отдаёт. Пока хук
 * ждёт, CLI стоит на нём: ни вызовов модели, ни таймаута самой команды.
 *
 * Что тяжело — решает `heavy-queue-classify.mjs` (по имени, по обёртке, по
 * опыту); здесь — замер команд, опыт на диске, билеты и аренды.
 *
 * Команду хук НЕ переписывает: правила разрешений CLI проверяются по тому, что
 * вернул хук, и обёртка спрятала бы `pnpm test && git push` от запретов
 * человека. Только ждёт и пропускает как есть — решение о правах остаётся CLI.
 * Отказ соседнего хука того же события этот хук не видит: CLI дожидается всех
 * (живьём 17.10), так что отказанная тяжёлая команда сперва отстоит очередь.
 *
 * Аренда живёт не дольше команды: передний план — таймаут Bash (по умолчанию
 * 2 мин) с запасом, фон — по опыту этой команды или `AGENTDECK_HEAVY_BACKGROUND_MS`
 * (10 мин): его конец хук не видит — `TaskCompleted` на фоновую Bash CLI не
 * зовёт (живьём 17.10). Команду, которую CLI сам увёл в фон по таймауту, аренда
 * держит дальше — гейт-то идёт. Убитый CLI отдаёт место по сроку. Аренды своей
 * же сессии не мешают ей.
 *
 * Без каталога очереди (`AGENTDECK_HEAVY_QUEUE_DIR`) и на любой сбой — тишина и
 * код 0: очередь экономит, но никогда не останавливает работу. Обход очереди
 * (ожидание вышло, сбой) пишется строкой в `bypass.log`: сама очередь иначе не
 * знает, сколько тяжёлого прошло мимо неё.
 */
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isHeavy,
  learnable,
  learnMs,
  numberEnv,
  steps,
  stepSignature,
} from './heavy-queue-classify.mjs';

export { isHeavy, steps, stepSignature };

/**
 * Секреты в строке команды в файл аренды не попадают: переменная (`TOKEN=…`,
 * `npm_token=…`), учётка в адресе (`postgres://u:pw@db`), ключ (`--token X`) и
 * заголовок (`-H "PRIVATE-TOKEN: …"`, `Authorization: Bearer …`).
 */
const SECRETS = [
  [/\b(\w*(token|secret|key|password|pass|pwd)\w*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=***'],
  [/(:\/\/[^\s/:@]*:)[^\s/@]+@/g, '$1***@'],
  [/(--?(token|password|pass|secret|api-?key)(=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***'],
  [/((token|authorization|api-?key|secret)[\w-]*:\s*)(bearer\s+|basic\s+)?[^\s"']+/gi, '$1***'],
];
export const shownCommand = (command) =>
  SECRETS.reduce(
    (text, [pattern, mask]) => text.replace(pattern, mask),
    String(command ?? ''),
  ).slice(0, 200);

/** Windows не даёт `rename` поверх файла, открытого соседом: несколько попыток. */
const RENAME_BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Запись целиком или никак: читатель полузаписанного файла счёл бы его битым и
 * удалил. Неудача убирает за собой временный файл (ревью A-F03).
 */
function writeAtomic(path, value) {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value));
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      if (attempt >= 10 || !RENAME_BUSY.has(error?.code)) {
        rmSync(temp, { force: true });
        throw error;
      }
      pause(20);
    }
  }
}

const FOREGROUND_DEFAULT_MS = 120_000;
const MARGIN_MS = 30_000;
/** Фоновую задачу CLI сам останавливает через 30 минут: дольше аренде жить незачем. */
const BACKGROUND_CAP_MS = 30 * 60_000;
/** Опыт старее месяца забывается: проект мог сменить гейт. */
const LEARN_TTL_MS = 30 * 86_400_000;
/** Отметка начала, не дождавшаяся конца (CLI убит), убирается через два часа. */
const START_TTL_MS = 2 * 3_600_000;
/** Журнал обходов не растёт без конца: старше — в `bypass.log.old`. */
const BYPASS_LOG_MAX = 64_000;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Безопасное имя файла. */
const fileId = (id) => String(id).replace(/[^\w.-]/g, '_');
/**
 * Имя вызова — сессия и id вызова: id у Qwen Code может повторяться между
 * сессиями, и две группы снимали бы аренды друг друга (ревью A-Q2).
 */
const callId = (input) =>
  fileId([input.session_id, input.tool_use_id ?? process.pid].filter(Boolean).join('.'));
/** Линия вызовов: сессия и её субагент (`agent_id` есть только у вызовов субагента). */
const laneOf = (input) => `${input.session_id ?? ''}/${input.agent_id ?? ''}`;

/**
 * Опыт — файл на подпись: два конца разом прежде переписывали общий файл, и
 * последний стирал подпись первого (25 из 30 замеров в пробе, ревью A-F03).
 */
const learnedPath = (dir, signature) =>
  join(dir, 'learned', `${createHash('sha1').update(signature).digest('hex').slice(0, 20)}.json`);

/** Каталог целиком или ничего: сбой чтения не должен отключать очередь. */
function listDir(root) {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

/** Опыт очереди: подпись → сколько шла (мс), только свежий. Нечитаемый опыт — пустой. */
export function loadLearned(dir, now = Date.now()) {
  const root = join(dir, 'learned');
  const out = new Map();
  for (const name of listDir(root)) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson(join(root, name));
    if (
      typeof entry?.signature === 'string' &&
      now - entry.at < LEARN_TTL_MS &&
      Number.isFinite(entry.ms)
    ) {
      out.set(entry.signature, entry.ms);
    }
  }
  return out;
}

/**
 * Записать опыт команды. Долгая — подписи её шагов запоминаются тяжёлыми;
 * короткая сдвигает уже известную подпись вниз (среднее с весом половины), так
 * что гейт, ставший быстрым, через пару прогонов из очереди уходит.
 *
 * `censored` — команду CLI увёл в фон, не дождавшись: `ms` лишь нижняя граница.
 * Такой замер известную подпись только поднимает и в среднее не идёт: 720 с
 * гейта с уведённым на второй минуте прогоном становились 420, и аренда кончалась
 * посреди него. Новую подпись он заводит, лишь когда агент сам просил долгий
 * таймаут (`seed`): dev-сервер, уведённый за две минуты, иначе стал бы «тяжёлым»
 * и держал место (ревью A-F01, A-F08).
 */
export function learn(dir, command, ms, now = Date.now(), censored = undefined) {
  const signatures = learnable(command, ms);
  if (!signatures) return;
  const root = join(dir, 'learned');
  mkdirSync(root, { recursive: true });
  for (const signature of signatures) {
    const path = learnedPath(dir, signature);
    const known = readJson(path);
    const fresh =
      known?.signature === signature && now - known.at < LEARN_TTL_MS && Number.isFinite(known.ms);
    let entry = null;
    if (fresh && censored) entry = { ...known, ms: Math.max(known.ms, ms), at: now };
    else if (fresh) {
      entry = { signature, ms: Math.round((known.ms + ms) / 2), n: (known.n ?? 1) + 1, at: now };
    } else if ((!censored || censored.seed) && ms >= learnMs()) {
      entry = { signature, ms, n: 1, at: now };
    }
    if (entry) writeAtomic(path, entry);
  }
  for (const name of readdirSync(root)) {
    if (!name.endsWith('.json')) continue;
    const entry = readJson(join(root, name));
    if (entry && !(now - entry.at < LEARN_TTL_MS)) rmSync(join(root, name), { force: true });
  }
}

/** Срок фоновой аренды: по опыту самой долгой из подписей команды с запасом. */
function backgroundSpan(command, learned) {
  const known = steps(String(command ?? ''))
    .map(stepSignature)
    .map((signature) => (signature ? learned?.get(signature) : undefined))
    .filter((ms) => Number.isFinite(ms));
  const fallback = numberEnv('AGENTDECK_HEAVY_BACKGROUND_MS', 600_000);
  if (known.length === 0) return fallback;
  return Math.min(BACKGROUND_CAP_MS, Math.max(60_000, Math.round(Math.max(...known) * 1.25)));
}

/** Живые аренды; просроченные и битые убираются по пути. */
function leases(dir, now) {
  const root = join(dir, 'leases');
  const out = [];
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!name.endsWith('.json')) continue;
    const lease = readJson(join(root, name));
    if (!lease || !(lease.until > now)) rmSync(join(root, name), { force: true });
    else out.push(lease);
  }
  return out;
}

/**
 * Живые билеты по порядку; билет умершего ожидающего убирается. Живой процесс
 * под номером ожидающего ещё не значит, что ждёт он: убитую группу сменит чужой
 * процесс с тем же номером, и её билет держал бы всех до конца ожидания — поэтому
 * билет старше самого долгого ожидания убирается тоже (ревью B2-F8).
 */
function tickets(dir, now, maxAge) {
  const root = join(dir, 'tickets');
  const out = [];
  for (const name of existsSync(root) ? readdirSync(root).sort() : []) {
    if (!name.endsWith('.json')) continue;
    const ticket = readJson(join(root, name));
    const stale = !ticket || !alive(ticket.pid) || !(now - ticket.created <= maxAge);
    if (stale) rmSync(join(root, name), { force: true });
    else out.push({ ...ticket, name });
  }
  return out;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Фон по просьбе модели: у Claude — `run_in_background`, у Qwen Code — `is_background`. */
const inBackground = (input) =>
  input.tool_input?.run_in_background === true || input.tool_input?.is_background === true;

/** Ждать места и взять аренду. Вернёт, сколько ждали, или `null` — ушли без аренды. */
export async function acquire(dir, input, now = Date.now, learned = undefined) {
  const slots = numberEnv('AGENTDECK_HEAVY_SLOTS', 1);
  // 25 мин — под таймаутом хука в 30. Аренда гейта с потолком группы живёт до
  // 30,5 мин, так что ждущий может уйти раньше неё и пойти разом: осознанно —
  // хук, убитый CLI по таймауту, пустил бы команду без билета и без следа в bypass.log.
  const maxWait = numberEnv('AGENTDECK_HEAVY_MAX_WAIT_MS', 1_500_000);
  const poll = numberEnv('AGENTDECK_HEAVY_POLL_MS', 1_000);
  const background = inBackground(input);
  const span = background
    ? backgroundSpan(input.tool_input?.command, learned)
    : (Number(input.tool_input?.timeout) || FOREGROUND_DEFAULT_MS) + MARGIN_MS;
  const session = String(input.session_id ?? '');
  const id = callId(input);
  mkdirSync(join(dir, 'tickets'), { recursive: true });
  mkdirSync(join(dir, 'leases'), { recursive: true });
  const start = now();
  const ticket = `${String(start).padStart(15, '0')}-${process.pid}-${id}.json`;
  const ticketPath = join(dir, 'tickets', ticket);
  const own = { pid: process.pid, session, created: start };
  writeAtomic(ticketPath, own);
  // Свой билет живёт, пока ждём: срок — само ожидание с запасом на опрос.
  const maxAge = maxWait + poll * 2 + MARGIN_MS;
  try {
    for (;;) {
      const time = now();
      // Билеты — раньше аренд: прошедший пишет аренду и лишь потом убирает билет.
      // В обратном порядке чтения между ними он успевал и то и другое — аренды
      // ещё нет, билета уже нет, и вторая команда шла рядом (ревью B2-F10).
      const queue = tickets(dir, time, maxAge).filter(
        (item) => item.session !== session || item.name === ticket,
      );
      const busy = leases(dir, time).filter((lease) => lease.session !== session).length;
      const position = queue.findIndex((item) => item.name === ticket);
      // Своего билета нет (его убрал чужой читатель) — вернуть на то же место и
      // ждать дальше: позиция −1 прежде пускала команду вперёд очереди (ревью A2-F6).
      if (position < 0) {
        writeAtomic(ticketPath, own);
      } else if (busy + position < slots) {
        writeAtomic(join(dir, 'leases', `${id}.json`), {
          session,
          lane: laneOf(input),
          toolUseId: input.tool_use_id ?? null,
          foreground: !background,
          until: time + span,
          command: shownCommand(input.tool_input?.command),
        });
        return time - start;
      }
      if (time - start >= maxWait) return null;
      await sleep(poll);
    }
  } finally {
    rmSync(ticketPath, { force: true });
  }
}

/**
 * Аренды переднего плана своей линии, кроме этого вызова, отдаются на следующем
 * вызове оболочки той же линии: Claude ведёт такие команды линии по одной, так что
 * прежняя уже кончилась. Так уходит аренда команды, которой отказал соседний хук:
 * после отказа CLI не зовёт ни `PostToolUse`, ни `PostToolUseFailure`, ни
 * `PermissionDenied` (живьём 17.10), и место держалось бы до её таймаута — до
 * получаса. Субагенты идут разом с основной линией — у них своя (`agent_id`).
 */
export function releaseLane(dir, input) {
  const root = join(dir, 'leases');
  const lane = laneOf(input);
  const own = `${callId(input)}.json`;
  for (const name of existsSync(root) ? readdirSync(root) : []) {
    if (!name.endsWith('.json') || name === own) continue;
    const lease = readJson(join(root, name));
    if (lease?.foreground === true && lease.lane === lane) {
      rmSync(join(root, name), { force: true });
    }
  }
}

/** Отметить начало вызова: по ней конец узнает, сколько шла команда, если CLI не сказал сам. */
export function stampStart(dir, input, now = Date.now()) {
  if (!input.tool_use_id) return;
  const root = join(dir, 'starts');
  mkdirSync(root, { recursive: true });
  writeAtomic(join(root, `${callId(input)}.json`), { at: now });
  // Только готовые отметки: чужой `.tmp` ещё пишется, и его удаление роняло
  // `rename` соседа — его команда шла мимо очереди (шесть групп разом, 17.10).
  for (const name of readdirSync(root).filter((file) => file.endsWith('.json'))) {
    const stamp = readJson(join(root, name));
    if (!stamp || !(now - stamp.at < START_TTL_MS)) rmSync(join(root, name), { force: true });
  }
}

/** Строка в журнал обходов: команда прошла без аренды. */
export function noteBypass(dir, input, reason, now = Date.now()) {
  try {
    const path = join(dir, 'bypass.log');
    if (existsSync(path) && statSync(path).size > BYPASS_LOG_MAX) {
      renameSync(path, `${path}.old`);
    }
    const line = `${new Date(now).toISOString()} ${reason} ${shownCommand(input.tool_input?.command)}`;
    appendFileSync(path, `${line.replace(/\s+/g, ' ')}\n`);
  } catch {
    // Журнал — по возможности.
  }
}

/**
 * Конец вызова: отдать аренду и записать опыт. Фоновая — нет: CLI зовёт
 * `PostToolUse` сразу при её запуске, и аренда снималась бы, пока гейт ещё идёт
 * (ревью A2-F5). Та же беда у команды, которую CLI увёл в фон сам, не дождавшись
 * её за таймаут (`backgroundTaskId` в ответе): гейт проекта шёл дольше десяти
 * минут, и аренда отдавалась посреди него. Такой аренде — фоновый срок с этой
 * минуты, не короче запасного: прошедшее время — лишь нижняя граница (ревью A-F01).
 *
 * Длительность — `duration_ms` от CLI: это время самой команды, без ожидания в
 * очереди и вопроса о правах. Отметка начала — запасной путь: в неё попадало
 * ожидание, и под нагрузкой гейт, ставший быстрым, из очереди не уходил (ревью A-F02).
 */
export function finish(dir, input, now = Date.now()) {
  if (!input.tool_use_id) return;
  const id = callId(input);
  const leasePath = join(dir, 'leases', `${id}.json`);
  const explicit = inBackground(input);
  const response = input.tool_response ?? {};
  const moved = !explicit && Boolean(response.backgroundTaskId);
  // Аренда — первой: всё ниже по возможности, и его сбой место держать не должен.
  if (!explicit && !moved) rmSync(leasePath, { force: true });
  const startPath = join(dir, 'starts', `${id}.json`);
  const stamp = readJson(startPath);
  try {
    rmSync(startPath, { force: true });
  } catch {
    // Отметку уберёт срок.
  }
  if (explicit) return;
  const reported = Number(input.duration_ms);
  const measured =
    Number.isFinite(reported) && reported >= 0 ? reported : stamp ? now - stamp.at : null;
  if (measured !== null) {
    const ran = Math.max(measured, moved ? Number(response.timedOutAfterMs) || 0 : 0);
    const censored = moved
      ? { seed: Number(input.tool_input?.timeout) > FOREGROUND_DEFAULT_MS }
      : undefined;
    try {
      learn(dir, input.tool_input?.command, ran, now, censored);
    } catch {
      // Этот замер пропадёт; следующий запишется.
    }
  }
  if (!moved) return;
  const lease = readJson(leasePath);
  if (!lease) return;
  const fallback = numberEnv('AGENTDECK_HEAVY_BACKGROUND_MS', 600_000);
  const span = Math.max(fallback, backgroundSpan(input.tool_input?.command, loadLearned(dir, now)));
  try {
    writeAtomic(leasePath, { ...lease, foreground: false, until: now + span });
  } catch {
    // Аренда доживёт свой срок переднего плана.
  }
}

/**
 * Оболочка под своим именем у каждого CLI: Claude — `Bash`, Qwen Code —
 * `run_shell_command` (матчер `Bash` он сводит к ней, а в stdin шлёт своё имя;
 * фон — `inBackground`). Живьём 17.10, qwen 0.25.
 */
const SHELL_TOOLS = new Set(['Bash', 'run_shell_command']);

async function main() {
  const dir = process.env.AGENTDECK_HEAVY_QUEUE_DIR;
  if (!dir) return;
  const input = JSON.parse(readFileSync(0, 'utf8'));
  if (!SHELL_TOOLS.has(input?.tool_name)) return;
  if (input.hook_event_name !== 'PreToolUse') {
    finish(dir, input);
    return;
  }
  // Только Claude: Qwen Code может вести вызовы хода разом, и прежняя команда линии ещё идёт.
  if (input.tool_name === 'Bash') {
    try {
      releaseLane(dir, input);
    } catch {
      // Отказанная аренда доживёт свой срок.
    }
  }
  const learned = loadLearned(dir);
  if (isHeavy(input.tool_input?.command, learned)) {
    try {
      const waited = await acquire(dir, input, Date.now, learned);
      if (waited === null) noteBypass(dir, input, 'timeout');
    } catch (error) {
      noteBypass(dir, input, `error:${error?.code ?? 'unknown'}`);
    }
  }
  // Начало — после ожидания: время в очереди длительностью команды не считается.
  try {
    stampStart(dir, input);
  } catch {
    // Без отметки пропадёт лишь замер этой команды.
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    await main();
  } catch {
    // Очередь не останавливает работу: любой сбой — команда идёт как есть.
  }
  process.exitCode = 0;
}
