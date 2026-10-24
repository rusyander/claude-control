import { networkInterfaces } from 'node:os';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { readProcessTableAsync, type ProcessRow } from '../../../lib/kill-tree.mjs';
import { ownerOf, readTcpTable, type TcpRow } from '../../../lib/peer-process/peer-process.ts';
import { readProcessFacts, type ProcessFacts } from '../../../lib/peer-process/process-facts.ts';
import {
  localVerdict,
  remoteHopValid,
  remoteVerdict,
  underRun,
  type GateFacts,
} from './human-gate.ts';
import { isThrowawayStand, osTempRoots, type PanelDirs } from './throwaway-stand.ts';

/**
 * Решение человека — только от человека (решение 3, D-n).
 *
 * Как защищались маршруты ответов до этого: никак, кроме сторожа источника
 * (`origin-guard`: запрос без Origin он пропускает — это `curl`) и ключа при
 * удалённом доступе (`~/.agentdeck/api-token`, который модель читает тем же
 * `cat`). Модель в прогоне могла ответить «разрешить» на свою же карточку.
 *
 * Здесь проверяется то, чего модель подделать не может: ЧЕЙ процесс держит
 * тот конец соединения. Ядро знает владельца сокета, таблица процессов — его
 * предков, факты ОС — путь программы и ключи запуска браузера. Верим трём:
 * вызову изнутри панели (`app.inject`, сокета нет), браузеру человека и прокси
 * Tailscale этой машины (`human-gate.ts`). Остальные — отказ. Исключение —
 * одноразовый стенд проверки (`throwaway-stand.ts`): там браузер автоматизации и
 * поднявшая панель проверка тоже проходят, иначе `tools/qa` не решили бы ни одной
 * карточки.
 *
 * Прокси Vite (`apps/web/vite.config.ts`) сам — процесс разработки и мог быть
 * поднят прогоном агента (перезапуск dev-сервера). Поэтому он передаёт порт
 * своего клиента заголовком `CLIENT_PORT_HEADER`, а сервер верит заголовку,
 * только если тот конец соединения действительно принял ЭТОТ процесс-сосед, и
 * судит уже владельца того порта (браузер). Подделанный заголовок от `curl`
 * ничего не даёт: судится и сам `curl`.
 *
 * Удалённый путь (телефон через Tailscale Serve) проверяется отдельно: адрес
 * сети Tailscale, ключ доступа И прокси этой машины на том конце. Запрос, чей
 * последний адрес `X-Forwarded-For` — адрес самой машины, пришёл отсюда же и
 * отбивается (на телефоне адрес другой).
 *
 * Два режима. `strict` — маршруты решений и все маршруты `human:*` журнала
 * возможностей (`ledger-gate.ts`): узнан или отказ. `lenient` — чтение списка
 * D-n: процессу модели список не отдаётся (он подсказывал бы ей номера своих же
 * вопросов), но неузнанный читатель не отбивается — иначе телефон и Telegram
 * теряли бы саму ленту.
 */

export const CLIENT_PORT_HEADER = 'x-agentdeck-client-port';

export type HumanRefusal =
  | 'model-process'
  | 'peer-unknown'
  | 'same-machine-remote'
  | 'device-unverified'
  | 'remote-unverified';

export type HumanCheck = { ok: true } | { ok: false; reason: HumanRefusal };

export interface HumanOnlyDeps {
  /** Корни процессов всех прогонов и живых сессий панели. */
  roots: () => readonly number[];
  readTable?: () => Promise<ProcessRow[] | undefined>;
  readTcp?: (wanted: ReadonlySet<number>) => Promise<TcpRow[] | undefined>;
  readFacts?: () => Promise<ProcessFacts | undefined>;
  /** Адреса этой машины — для Tailscale Serve. */
  ownAddresses?: () => readonly string[];
  platform?: string;
  /** Узнанные браузеры (`pid:created`); по умолчанию — общий на процесс панели. */
  known?: Set<string>;
  /** Узнанные прокси Tailscale и пропуски шва стенда — так же, отдельными наборами. */
  knownProxies?: Set<string>;
  knownStand?: Set<string>;
  /** Окружение панели для правила браузера (`GateFacts.env`). */
  env?: NodeJS.ProcessEnv;
  /** Каталоги панели сейчас — для шва одноразового стенда; нет — шва нет. */
  panelDirs?: () => PanelDirs | undefined;
  /** Корни temp ОС (`osTempRoots`); подменяются в тестах. */
  standRoots?: () => readonly string[];
  /** Номер процесса панели (по умолчанию свой). */
  self?: number;
}

export type HumanMode = 'strict' | 'lenient';

/**
 * Браузеры, уже узнанные: путь программы и ключи запуска процесса не меняются,
 * пока жив процесс, а ключ с временем создания не даёт занять номер другому.
 * Без этого каждое решение платило бы за запрос WMI (~0,9 с на Windows).
 * Прогон среди предков проверяется всё равно каждый раз — по свежей таблице.
 */
const KNOWN_BROWSERS = new Set<string>();
/**
 * Так же держатся за процесс два других пропуска (24.10): прокси Tailscale этой
 * машины (имя программы и сеанс службы у процесса не меняются) и шов
 * одноразового стенда (браузер автоматизации по имени, линия предков панели).
 * Без памяти каждое решение с телефона и каждый вызов проверки на стенде платили
 * ~1,3 с за WMI. Наборы раздельные намеренно: ключ прокси не пускает локальный
 * запрос — иначе сам прокси без `X-Forwarded-For` прошёл бы без ключа доступа, —
 * а ключ шва действует, только пока каталоги панели — стенд. Ключ доступа и
 * адрес tailnet у удалённого запроса проверяются всё равно каждый раз.
 */
const KNOWN_PROXIES = new Set<string>();
const KNOWN_STAND = new Set<string>();
const KNOWN_LIMIT = 512;

function remember(set: Set<string>, key: string | undefined): void {
  if (!key) return;
  if (set.size >= KNOWN_LIMIT) set.clear();
  set.add(key);
}

function machineAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) out.push(entry.address);
  }
  return out;
}

function normalizeAddress(value: string): string {
  return value
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/, '');
}

function lastForwarded(header: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(header) ? header.join(',') : header;
  const last = raw?.split(',').at(-1)?.trim();
  return last ? normalizeAddress(last) : undefined;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Порт клиента за прокси Vite — заголовок, которому верят только вместе с деревом. */
function hopPortOf(request: Pick<FastifyRequest, 'headers'>): number | undefined {
  const port = Number(firstHeader(request.headers[CLIENT_PORT_HEADER]));
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

/** Кого судим: владелец сокета или клиент за прокси Vite (браузер). */
function subjectOf(tcp: readonly TcpRow[], peer: number, hop: number | undefined): number {
  if (!hop) return peer;
  // Сосед — прокси, только если ОН принял соединение с портом из заголовка:
  // строка «мой порт = порт прокси, тот конец = hop» принадлежит соседу.
  const accepted = tcp.find((row) => row.remotePort === hop && row.pid === peer);
  const client = accepted ? ownerOf(tcp, hop, accepted.localPort) : undefined;
  return accepted && client ? client : peer;
}

const keyOf = (table: readonly ProcessRow[], pid: number): string | undefined => {
  const created = table.find((row) => row.pid === pid)?.created;
  return created && created > 0n ? `${pid}:${created}` : undefined;
};

export async function checkHumanCaller(
  request: Pick<FastifyRequest, 'headers' | 'socket'>,
  deps: HumanOnlyDeps,
  mode: HumanMode = 'strict',
): Promise<HumanCheck> {
  const forwarded = lastForwarded(request.headers['x-forwarded-for']);
  const remote = Boolean(forwarded) && !LOOPBACK.has(forwarded as string);
  if (remote) {
    const own = (deps.ownAddresses ?? machineAddresses)().map(normalizeAddress);
    if (own.includes(forwarded as string)) return { ok: false, reason: 'same-machine-remote' };
  }
  const peerPort = request.socket.remotePort;
  const serverPort = request.socket.localPort;
  // Ни одного порта — вызов изнутри процесса сервера (`app.inject`): сети тут
  // нет, а кто из своих вправе звать маршрут решения, держит журнал
  // возможностей агента панели (`human:rights` ему закрыт).
  if (peerPort === undefined && serverPort === undefined) return { ok: true };
  if (!peerPort || !serverPort) return { ok: false, reason: 'peer-unknown' };
  const roots = new Set(deps.roots());
  // Чтение списка: ни одного процесса модели — судить некого, таблицы ОС не
  // читаем. На маршруте решения такой пропуск недопустим: «прогонов нет» не
  // значит «звонит человек».
  if (mode === 'lenient' && roots.size === 0) return { ok: true };
  const hop = hopPortOf(request);
  const wanted = new Set(hop ? [peerPort, hop] : [peerPort]);
  const platform = deps.platform ?? process.platform;

  const [tcp, table] = await Promise.all([
    (deps.readTcp ?? ((ports) => readTcpTable(ports, platform)))(wanted),
    (deps.readTable ?? (() => readProcessTableAsync()))(),
  ]);
  if (!tcp || !table) return { ok: false, reason: 'peer-unknown' };
  const peer = ownerOf(tcp, peerPort, serverPort);
  if (!peer) return { ok: false, reason: 'peer-unknown' };
  const subject = subjectOf(tcp, peer, hop);
  const bare: GateFacts = {
    table,
    facts: new Map(),
    roots,
    platform,
    ...(deps.env ? { env: deps.env } : {}),
  };
  if (underRun(subject, bare)) return { ok: false, reason: 'model-process' };
  if (mode === 'lenient') return { ok: true };

  const known = deps.known ?? KNOWN_BROWSERS;
  const proxies = deps.knownProxies ?? KNOWN_PROXIES;
  const seam = deps.knownStand ?? KNOWN_STAND;
  const key = keyOf(table, subject);
  const hopInput = { hop: forwarded ?? '', bearer: Boolean(request.headers.authorization) };
  // Стенд судится на каждом вызове (каталоги панели могли смениться) — это
  // сравнение путей, без чтения ОС.
  const stand = isThrowawayStand(
    deps.panelDirs?.(),
    (deps.standRoots ?? (() => osTempRoots(platform)))(),
    platform,
  );
  if (key) {
    if (remote) {
      if (proxies.has(key)) {
        return remoteHopValid(hopInput) ? { ok: true } : { ok: false, reason: 'remote-unverified' };
      }
    } else if (known.has(key) || (stand && seam.has(key))) {
      return { ok: true };
    }
  }
  const facts = await (deps.readFacts ?? (() => readProcessFacts(platform)))();
  if (!facts) return { ok: false, reason: 'peer-unknown' };
  const gate: GateFacts = {
    ...bare,
    facts,
    ...(stand ? { stand: { self: deps.self ?? process.pid } } : {}),
  };

  if (remote) {
    const verdict = remoteVerdict(subject, gate, hopInput);
    if (verdict === 'human') {
      remember(proxies, key);
      return { ok: true };
    }
    return {
      ok: false,
      reason: verdict === 'model-process' ? 'model-process' : 'remote-unverified',
    };
  }
  const verdict = localVerdict(subject, gate);
  if (verdict === 'human') {
    // Пропуск на стенде — в свой набор: вне стенда он не действует.
    remember(stand ? seam : known, key);
    return { ok: true };
  }
  return { ok: false, reason: verdict === 'model-process' ? 'model-process' : 'device-unverified' };
}

const REFUSALS: Record<
  HumanRefusal,
  { status: number; code: string; messageCode: string; message: string }
> = {
  'model-process': {
    status: 403,
    code: 'decision_human_only',
    messageCode: 'decision-human-only',
    message:
      'Решение отклонено: запрос пришёл от процесса агента панели. Отвечать на запросы прав и отложенные вопросы может только человек.',
  },
  'peer-unknown': {
    status: 503,
    code: 'decision_peer_unknown',
    messageCode: 'decision-peer-unknown',
    message:
      'Решение не принято: панель не смогла проверить, кто его прислал. Повторите через несколько секунд.',
  },
  'same-machine-remote': {
    status: 403,
    code: 'decision_human_only',
    messageCode: 'decision-human-only',
    message:
      'Решение отклонено: запрос пришёл от процесса агента панели. Отвечать на запросы прав и отложенные вопросы может только человек.',
  },
  'device-unverified': {
    status: 403,
    code: 'decision_device_unverified',
    messageCode: 'decision-device-unverified',
    message:
      'Решение не принято: панель не узнала окно, из которого он пришёл. Откройте панель в браузере на этом компьютере и ответьте оттуда.',
  },
  'remote-unverified': {
    status: 403,
    code: 'decision_remote_unverified',
    messageCode: 'decision-remote-unverified',
    message:
      'Решение не принято: удалённый ответ принимается только через Tailscale Serve этой машины с ключом доступа.',
  },
};

/** Отказ маршрута решения: 403 с кодом текста, ничего не решено. */
export function refuseNonHuman(reply: FastifyReply, check: Exclude<HumanCheck, { ok: true }>) {
  const refusal = REFUSALS[check.reason];
  return reply
    .code(refusal.status)
    .send({ code: refusal.code, message: refusal.message, messageCode: refusal.messageCode });
}

/**
 * Метка ворот на `preHandler`: по ней проверка таблицы маршрутов
 * (`ledger-gate.test.ts`) видит, что маршрут закрыт, а общий хук журнала
 * возможностей не ставит ворота второй раз.
 */
export const HUMAN_GATE = Symbol.for('agentdeck.human-gate');

export type HumanGateHandler = ((request: FastifyRequest, reply: FastifyReply) => Promise<void>) & {
  [HUMAN_GATE]: HumanMode;
};

function tagged(
  mode: HumanMode,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): HumanGateHandler {
  return Object.assign(handler, { [HUMAN_GATE]: mode });
}

/** Режим ворот у обработчика (`undefined` — не ворота). */
export function gateModeOf(handler: unknown): HumanMode | undefined {
  return typeof handler === 'function'
    ? ((handler as Partial<HumanGateHandler>)[HUMAN_GATE] ?? undefined)
    : undefined;
}

/**
 * `preHandler` для маршрутов решений: проверка до разбора тела, чтобы ни одна
 * ветка решения не успела сработать.
 */
export function humanOnly(deps: HumanOnlyDeps): HumanGateHandler {
  return tagged('strict', async (request, reply) => {
    const check = await checkHumanCaller(request, deps);
    if (!check.ok) await refuseNonHuman(reply, check);
  });
}

/**
 * `preHandler` для чтения списка D-n: отбивает только процесс модели. Список —
 * не решение, и телефон с Telegram должны видеть ленту без узнавания окна.
 */
export function humanOnlyRead(deps: HumanOnlyDeps): HumanGateHandler {
  return tagged('lenient', async (request, reply) => {
    const check = await checkHumanCaller(request, deps, 'lenient');
    if (!check.ok) await refuseNonHuman(reply, check);
  });
}
