import type { ServiceEndpoint } from '@agentdeck/contracts/core/records';
import { eolOf } from '../../platform/encoding.ts';
import {
  classifyEnv,
  hostOf,
  isHostVar,
  isPortVar,
  protocolOf,
  schemeOfName,
  schemeOfValue,
  type Scheme,
} from './classify.ts';

/**
 * Переписывание окружения копии (04:93-94, P84 — половина переписывания). Каждая сервисная
 * переменная копии — адрес (URL, хост, `host:port`), порт, учётка или настройка. Адрес указывает
 * на эфемерный контейнер задачи; нет контейнера его схемы — строка снимается (слот
 * `# agentdeck-removed: ИМЯ [схема вид]` БЕЗ значения) и переменная названа на единице: копия
 * никогда не держит адрес не-эфемерной базы. Хост без порта своего семейства получает порт
 * контейнера строкой рядом: иначе клиент возьмёт порт по умолчанию — локальную базу человека.
 * Порт и учётка идут за переписанным адресом своего семейства. Слот восстанавливается, когда
 * контейнер схемы появился (настройка копии сняла, дорога сервисов вернула). Значения в отчёт
 * не попадают (04:91).
 */

export interface EnvLineChange {
  name: string;
  action: 'rewritten' | 'removed';
  scheme: Scheme;
  /** Для `removed` — почему (нет контейнера схемы, неоднозначно); для `rewritten` — рецепт. */
  why: string;
}

export interface EnvTextRewrite {
  text: string;
  changes: EnvLineChange[];
}

interface Target {
  recipe: string;
  url: string;
  host: string;
  port?: number;
}

type VarKind = 'url' | 'host' | 'port' | 'address' | 'credential' | 'config';

const KINDS: readonly VarKind[] = ['url', 'host', 'port', 'address', 'credential', 'config'];
const SERVICE_SCHEMES: readonly Scheme[] = [
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  'amqp',
  'kafka',
];
const DB_SCHEMES: Scheme[] = ['postgres', 'mysql', 'mongodb'];

const URL_NAME = /(_URL|_URI|_DSN|^DSN|^DATABASE_URL)$/i;
const USER_NAME = /(USER|USERNAME)$/i;
const PASSWORD_NAME = /(PASSWORD|PASS|PWD)$/i;
const DATABASE_NAME = /(DATABASE|DBNAME|_NAME|_DB)$/i;
const ADDRESS_NAME =
  /(_ADDRS?|_ADDRESS(ES)?|_SERVERS?|_BROKERS?|_HOSTS|_NODES|_ENDPOINTS?|_SEEDS)$/i;
const HOST_PART = String.raw`(?:\[[0-9a-fA-F:]+\]|[\w-]*[A-Za-z.][\w.-]*)`;
const ADDRESS_VALUE = new RegExp(`^${HOST_PART}:\\d+(?:\\s*,\\s*${HOST_PART}:\\d+)*$`);
const FAMILY_SUFFIX =
  /(_HOSTNAME|_HOST|_PORT|_URL|_URI|_DSN|_USERNAME|_USER|_PASSWORD|_PASS|_PWD|_DATABASE|_DBNAME|_NAME|_DB|_ADDRS?|_ADDRESS(ES)?|_SERVERS?|_BROKERS?|_HOSTS|_NODES|_ENDPOINTS?|_SEEDS|HOST|PORT|USER|PASSWORD|DATABASE)$/;

const LINE = /^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*(.*)$/;
const SLOT = /^\s*# agentdeck-removed: ([A-Za-z_][\w.]*) \[(\w+) (\w+)\] — /;
const LEGACY_SLOT = /^\s*# agentdeck: ([A-Za-z_][\w.]*) removed — /;

interface Entry {
  name: string;
  value: string;
  slot?: { scheme?: Scheme; kind?: VarKind };
}

interface Var {
  name: string;
  value: string;
  kind: VarKind;
  scheme: Scheme | 'ambiguous' | undefined;
  family: string;
  slot: boolean;
}

function endpointsByScheme(endpoints: readonly ServiceEndpoint[]): Map<Scheme, Target[]> {
  const map = new Map<Scheme, Target[]>();
  for (const e of [...endpoints].sort((a, b) => (a.recipe < b.recipe ? -1 : 1))) {
    const scheme = schemeOfValue(e.url);
    const at = hostOf('URL', e.url);
    if (!scheme || !at) continue;
    const list = map.get(scheme) ?? [];
    list.push({
      recipe: e.recipe,
      url: e.url,
      host: at.host,
      ...(at.port !== undefined ? { port: at.port } : {}),
    });
    map.set(scheme, list);
  }
  return map;
}

/**
 * Схема переменной: из значения, из имени; без семейства и без протокола (`DB_HOST`, `DB_USER`)
 * — единственная БД среди контейнеров. Незнакомый протокол (`sqlserver://`) — чужой сервис,
 * его единственная БД задачи не заменяет.
 */
function schemeFor(
  name: string,
  value: string,
  targets: Map<Scheme, Target[]>,
): Scheme | 'ambiguous' | undefined {
  const s = schemeOfValue(value) ?? schemeOfName(name);
  if (s) return s;
  if (protocolOf(value) !== undefined) return undefined;
  const dbs = DB_SCHEMES.filter((d) => targets.has(d));
  if (dbs.length === 1) return dbs[0];
  return dbs.length > 1 ? 'ambiguous' : undefined;
}

function kindOf(name: string, value: string): VarKind {
  if (value.includes('://') || URL_NAME.test(name)) return 'url';
  if (isHostVar(name)) return 'host';
  if (isPortVar(name)) return 'port';
  if (USER_NAME.test(name) || PASSWORD_NAME.test(name) || DATABASE_NAME.test(name)) {
    return 'credential';
  }
  if (ADDRESS_NAME.test(name) || ADDRESS_VALUE.test(value)) return 'address';
  return 'config';
}

/** Семейство: `POSTGRES_HOST` ↔ `POSTGRES_PORT` ↔ `POSTGRES_USER`, `PGHOST` ↔ `PGPORT`. */
function familyOf(name: string): string {
  return name.toUpperCase().replace(FAMILY_SUFFIX, '');
}

function parseEntry(raw: string): Entry | undefined {
  const slot = SLOT.exec(raw);
  if (slot) {
    const scheme = SERVICE_SCHEMES.find((s) => s === slot[2]);
    const kind = KINDS.find((k) => k === slot[3]);
    return {
      name: slot[1] as string,
      value: '',
      slot: { ...(scheme ? { scheme } : {}), ...(kind ? { kind } : {}) },
    };
  }
  const legacy = LEGACY_SLOT.exec(raw);
  if (legacy) return { name: legacy[1] as string, value: '', slot: {} };
  const m = LINE.exec(raw);
  if (!m) return undefined;
  let value = (m[2] as string).trim();
  if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/, '');
  return { name: m[1] as string, value };
}

function varOf(e: Entry, targets: Map<Scheme, Target[]>): Var | undefined {
  const base = { name: e.name, family: familyOf(e.name) };
  if (e.slot) {
    // Слот без значения: класс — по имени или по схеме, записанной при снятии.
    if (!e.slot.scheme && classifyEnv([{ name: e.name }]).length === 0) return undefined;
    return {
      ...base,
      value: '',
      kind: e.slot.kind ?? kindOf(e.name, ''),
      scheme: e.slot.scheme ?? schemeFor(e.name, '', targets),
      slot: true,
    };
  }
  if (classifyEnv([e]).length === 0) return undefined;
  return {
    ...base,
    value: e.value,
    kind: kindOf(e.name, e.value),
    scheme: schemeFor(e.name, e.value, targets),
    slot: false,
  };
}

function setValue(raw: string, name: string, next: string): string {
  const m = /^(\s*(?:export\s+)?[A-Za-z_][\w.]*\s*=\s*)(.*)$/.exec(raw);
  if (!m) return `${name}=${next}`;
  const old = (m[2] as string).trim();
  const q = /^(['"])/.exec(old)?.[1] ?? '';
  return `${m[1]}${q}${next}${q}`;
}

/** Учётка из адреса контейнера; нет части в адресе — `undefined` (значение не трогается). */
function credentialOf(t: Target, name: string, scheme: Scheme | undefined): string | undefined {
  let url: URL;
  try {
    url = new URL(t.url);
  } catch {
    return undefined;
  }
  if (USER_NAME.test(name)) return url.username ? decodeURIComponent(url.username) : undefined;
  if (PASSWORD_NAME.test(name)) return url.password ? decodeURIComponent(url.password) : undefined;
  if (!scheme || !DB_SCHEMES.includes(scheme)) return undefined;
  const db = decodeURIComponent(url.pathname.replace(/^\//, ''));
  return db === '' ? undefined : db;
}

function portNameFor(hostName: string): string {
  if (/^PGHOST$/i.test(hostName))
    return hostName.replace(/HOST$/i, (h) => (h === 'HOST' ? 'PORT' : 'port'));
  return hostName.replace(/(_HOSTNAME|_HOST)$/i, (s) =>
    s === s.toUpperCase() ? '_PORT' : '_port',
  );
}

interface Plan {
  movedFamily: Map<string, Target>;
  movedScheme: Map<Scheme, Target>;
  portFamilies: Set<string>;
}

function targetOf(v: Var, targets: Map<Scheme, Target[]>): Target | undefined {
  if (!v.scheme || v.scheme === 'ambiguous') return undefined;
  return targets.get(v.scheme)?.[0];
}

/** Что переписано во всём наборе файлов корня: порт и учётка идут за адресом через файлы. */
function planOf(vars: readonly Var[], targets: Map<Scheme, Target[]>): Plan {
  const plan: Plan = { movedFamily: new Map(), movedScheme: new Map(), portFamilies: new Set() };
  for (const v of vars) {
    if (v.kind === 'port' && !v.slot) plan.portFamilies.add(v.family);
    if (v.kind !== 'url' && v.kind !== 'host' && v.kind !== 'address') continue;
    const t = targetOf(v, targets);
    if (!t || t.port === undefined) continue;
    plan.movedFamily.set(v.family, t);
    plan.movedScheme.set(v.scheme as Scheme, t);
  }
  return plan;
}

function varsOf(text: string, targets: Map<Scheme, Target[]>): (Var | undefined)[] {
  return text.split(/\r?\n/).map((raw) => {
    const e = parseEntry(raw);
    return e ? varOf(e, targets) : undefined;
  });
}

/**
 * Переписать один файл окружения. `siblings` — тексты остальных файлов того же корня
 * (`.env` ↔ `.env.local`): пара хост/порт и учётка семейства бывают разнесены по файлам.
 */
export function rewriteEnvText(
  text: string,
  endpoints: readonly ServiceEndpoint[],
  siblings: readonly string[] = [],
): EnvTextRewrite {
  const targets = endpointsByScheme(endpoints);
  const eol = eolOf(text);
  const lines = text.split(/\r?\n/);
  const own = varsOf(text, targets);
  const all = [...own, ...siblings.flatMap((s) => varsOf(s, targets))].filter(
    (v): v is Var => v !== undefined,
  );
  const plan = planOf(all, targets);
  const changes: EnvLineChange[] = [];
  const rewritten = (v: Var, raw: string, next: string, t: Target, scheme: Scheme): string => {
    changes.push({ name: v.name, action: 'rewritten', scheme, why: t.recipe });
    return v.slot ? `${v.name}=${next}` : setValue(raw, v.name, next);
  };
  const out = lines.flatMap((raw, i): string[] => {
    const v = own[i];
    if (!v) return [raw];
    const scheme = v.scheme === 'ambiguous' ? undefined : v.scheme;
    const remove = (why: string): string[] => {
      // Слот остаётся слотом: второй раз не снимается и не называется.
      if (v.slot) return [raw];
      changes.push({ name: v.name, action: 'removed', scheme: scheme ?? 'other', why });
      return [`# agentdeck-removed: ${v.name} [${scheme ?? 'other'} ${v.kind}] — ${why}`];
    };
    const t = targetOf(v, targets);
    switch (v.kind) {
      case 'config':
        return [raw];
      case 'port': {
        const pt = plan.movedFamily.get(v.family) ?? t;
        if (!pt || pt.port === undefined) return [raw];
        return [rewritten(v, raw, String(pt.port), pt, schemeOfValue(pt.url) ?? 'other')];
      }
      case 'credential': {
        const ct =
          plan.movedFamily.get(v.family) ?? (scheme ? plan.movedScheme.get(scheme) : undefined);
        const next = ct ? credentialOf(ct, v.name, schemeOfValue(ct.url)) : undefined;
        if (!ct || next === undefined || next === v.value) return [raw];
        return [rewritten(v, raw, next, ct, schemeOfValue(ct.url) ?? 'other')];
      }
      default:
        break;
    }
    if (v.scheme === 'ambiguous') return remove('several database containers, scheme not named');
    if (!scheme || !t) return remove(`no ephemeral ${scheme ?? 'service'} container for this task`);
    if (v.kind === 'url') {
      const next = v.value.startsWith('jdbc:') ? `jdbc:${t.url}` : t.url;
      return [rewritten(v, raw, next, t, scheme)];
    }
    // Хост и `host:port` без порта контейнера — половина адреса: снять, а не держать.
    if (t.port === undefined) return remove(`${scheme} container address has no port`);
    if (v.kind === 'address') return [rewritten(v, raw, `${t.host}:${t.port}`, t, scheme)];
    const line = rewritten(v, raw, t.host, t, scheme);
    if (plan.portFamilies.has(v.family)) return [line];
    const portName = portNameFor(v.name);
    changes.push({ name: portName, action: 'rewritten', scheme, why: `${t.recipe} (port pinned)` });
    return [line, `${portName}=${t.port}`];
  });
  return { text: out.join(eol), changes };
}
