import type { EstimateReply } from './estimate.ts';

/**
 * Сигнал для человека (этап 9): строка `signal` журнала несёт id, серьёзность, предмет и деталь.
 * Деталь — английская проза ядра (P32: показывается дословно) либо, у шести сигналов оценки и
 * сессии, JSON его чисел. Здесь — ЗАКРЫТЫЙ список id каталога ядра (`observer/catalog.ts`), что
 * означает предмет каждого и в какой форме ядро пишет деталь; и одно чтение JSON-детали в факты.
 * Шаблоны панели типизированы этим списком: новый сигнал без шаблона не соберётся, а тест панели
 * сверяет список с каталогом ядра в обе стороны. Прозу здесь не разбирают никогда.
 */

/** Что стоит в `subject` строки сигнала — подпись предмета на экране. */
export const SIGNAL_SUBJECTS = [
  'phase',
  'ask',
  'repo',
  'step',
  'session',
  'target',
  'kind',
  'model',
  'hook',
  'config',
  'entry',
  'path',
  'lease',
  'snapshot',
  'line',
  'command',
  'resource',
  'route',
] as const;
export type SignalSubject = (typeof SIGNAL_SUBJECTS)[number];

/** `prose` — английский текст ядра, показывается дословно; `json` — числа, читаются в факты. */
export type SignalDetailForm = 'prose' | 'json';

interface SignalViewDef {
  subject: SignalSubject;
  detail: SignalDetailForm;
}

// Форма детали остаётся литералом в типе: по ней `FACTS` обязан иметь чтение каждого JSON-сигнала.
const prose = (subject: SignalSubject) => ({ subject, detail: 'prose' as const });
const json = (subject: SignalSubject) => ({ subject, detail: 'json' as const });

/** Каталог ядра по id: предмет и форма детали — как их пишет владелец сигнала. */
export const SIGNAL_VIEW = {
  preflight: json('phase'),
  'ask-reminder': prose('ask'),
  'ask-refused': prose('ask'),
  'mcp-human': prose('kind'),
  'estimate-refused': json('phase'),
  'base-pin': prose('repo'),
  'user-layer-report': json('phase'),
  'estimate-history': json('phase'),
  ownership: prose('target'),
  'forged-authority': prose('target'),
  'step-done-refused': prose('step'),
  'step-done-invalid': prose('step'),
  'step-blocker': prose('kind'),
  'model-served': prose('model'),
  'route-mismatch': prose('session'),
  'profile-moved': prose('repo'),
  'context-drift': prose('session'),
  'forged-publish': prose('target'),
  'hook-block': prose('hook'),
  'hook-loop': prose('hook'),
  'keep-warm': json('session'),
  'session-refused': prose('step'),
  'resume-refused': prose('session'),
  'chat-in-place': prose('repo'),
  'read-allow-unread': prose('config'),
  'read-scope-refused': prose('entry'),
  'permit-sources-unread': prose('entry'),
  'capture-roads': prose('session'),
  'resources-unread': prose('session'),
  'protected-root-unread': prose('repo'),
  'protected-root': prose('path'),
  'route-lease': json('lease'),
  'layer-loss': prose('session'),
  'session-snapshot': prose('snapshot'),
  'journal-rejected': prose('line'),
  'waste-reread': prose('path'),
  'waste-big-read': prose('path'),
  'waste-fail-repeat': prose('command'),
  'waste-poll': prose('command'),
  'waste-refusal-repeat': prose('target'),
  'context-growth': prose('session'),
  stall: prose('session'),
  'resource-leak': prose('resource'),
  window: prose('route'),
} as const satisfies Record<string, SignalViewDef>;

export type SignalId = keyof typeof SIGNAL_VIEW;
export const SIGNAL_IDS = Object.keys(SIGNAL_VIEW) as SignalId[];

export function isSignalId(id: string): id is SignalId {
  return Object.hasOwn(SIGNAL_VIEW, id);
}

/** Подписи фактов JSON-детали — закрытый список, у панели на каждый есть перевод. */
export const SIGNAL_FACT_KEYS = [
  'problems',
  'minutes',
  'tokens',
  'spread',
  'basis',
  'reasons',
  'route',
  'model',
  'resources',
  'hash',
  'hooks',
  'skills',
  'warnings',
  'sources',
  'grants',
  'changes',
] as const;
export type SignalFactKey = (typeof SIGNAL_FACT_KEYS)[number];

/**
 * Факт детали: `key` — подпись из списка выше, либо `label` — имя из самих данных (дорога
 * предпроверки, число решения), которое не переводится. `value` — короткое значение, `items` —
 * список (прозу ядра в нём показывают дословно).
 */
export type SignalFact = ({ key: SignalFactKey } | { label: string }) & {
  value?: string;
  items?: string[];
};

/**
 * Деталь на экран: `text` — дословный текст ядра; `facts` — разобранный JSON известного сигнала;
 * `keys` — JSON, чьей формы панель не знает (сигнал вне каталога или форма сменилась): только
 * имена ключей и короткие значения, без дампа.
 */
export type SignalDetailView =
  | { form: 'none' }
  | { form: 'text'; text: string }
  | { form: 'facts'; facts: SignalFact[] }
  | { form: 'keys'; keys: { key: string; value: string }[] };

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const scalar = (v: unknown): string | undefined =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined;

function parseJson(detail: string): unknown {
  try {
    return JSON.parse(detail) as unknown;
  } catch {
    return undefined;
  }
}

/** Короткое значение ключа: скаляр как есть, список — «[n]», объект — «{n}». */
function brief(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length}]`;
  if (isObj(v)) return `{${Object.keys(v).length}}`;
  const s = scalar(v) ?? '';
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

/** JSON неизвестной формы — список ключей верхнего уровня; у массива — его длина. */
export function signalKeys(value: unknown): { key: string; value: string }[] {
  if (Array.isArray(value)) return [{ key: '#', value: brief(value) }];
  if (!isObj(value)) return [{ key: '=', value: brief(value) }];
  return Object.entries(value).map(([key, v]) => ({ key, value: brief(v) }));
}

const fact = (key: SignalFactKey, value: unknown): SignalFact[] => {
  const s = scalar(value);
  return s === undefined ? [] : [{ key, value: s }];
};
const list = (key: SignalFactKey, items: string[]): SignalFact[] =>
  items.length > 0 ? [{ key, items }] : [];
const mode = (o: unknown, k: string): string | undefined => (isObj(o) ? scalar(o[k]) : undefined);
const shift = (asked: unknown, ran: unknown, k: string): string | undefined => {
  const a = mode(asked, k);
  const r = mode(ran, k);
  if (a === undefined || r === undefined) return undefined;
  return a === r ? a : `${a} → ${r}`;
};

type PreflightRow = EstimateReply['preflight'][number];
type HistoryNumbers = EstimateReply['estimate'];

/**
 * Чтение JSON каждого сигнала оценки и сессии — форма, как её пишет ядро (одна запись на сигнал).
 * `null` — форма не та: деталь пойдёт ключами, а не выдуманными фактами.
 */
type JsonSignal = {
  [S in SignalId]: (typeof SIGNAL_VIEW)[S]['detail'] extends 'json' ? S : never;
}[SignalId];

const FACTS: { [S in JsonSignal]: (v: unknown) => SignalFact[] | null } = {
  // `preflight-run`: строки дорог предпроверки `{road, status, detail}`.
  preflight: (v) => {
    if (!Array.isArray(v)) return null;
    return (v as Partial<PreflightRow>[]).filter(isObj).map((r) => ({
      label: String(r.road ?? '?'),
      value: [r.status, r.detail].filter(Boolean).join(' — '),
    }));
  },
  // Причины отказа — прозой ядра, список строк.
  'estimate-refused': (v) => (Array.isArray(v) ? list('problems', strs(v)) : null),
  // Слой пользователя на запуске: отчёт (`hash`, режимы просил → вышло, предупреждения) и гранты.
  'user-layer-report': (v) => {
    if (!isObj(v) || !isObj(v.report)) return null;
    const r = v.report;
    const hash = typeof r.hash === 'string' ? r.hash.slice(0, 12) : 'null';
    return [
      { key: 'hash', value: hash },
      ...fact('hooks', shift(r.asked, r.ran, 'hooks')),
      ...fact('skills', shift(r.asked, r.ran, 'skills')),
      ...fact('sources', r.sources),
      ...fact('warnings', Array.isArray(r.warnings) ? r.warnings.length : undefined),
      ...fact('grants', Array.isArray(v.grants) ? v.grants.length : undefined),
      ...list('changes', strs(r.detail)),
    ];
  },
  // Числа истории: минуты, токены, разброс [p10, p90], основание.
  'estimate-history': (v) => {
    if (!isObj(v)) return null;
    const n = v as Partial<HistoryNumbers>;
    const spread = Array.isArray(n.spread) ? n.spread.join('–') : undefined;
    return [
      ...fact('basis', n.basis),
      ...fact('minutes', n.minutes),
      ...fact('tokens', n.tokens),
      ...fact('spread', spread),
    ];
  },
  // Прогрев сессии: числа решения по именам и причины прозой.
  'keep-warm': (v) => {
    if (!isObj(v)) return null;
    const numbers = isObj(v.numbers) ? v.numbers : {};
    return [
      ...Object.entries(numbers).flatMap(([label, n]) => {
        const s = scalar(n);
        return s === undefined ? [] : [{ label, value: s }];
      }),
      ...list('reasons', strs(v.reasons)),
    ];
  },
  // Аренда маршрута: маршрут, модель, ресурсы аренды.
  'route-lease': (v) => {
    if (!isObj(v)) return null;
    return [
      ...fact('route', v.routeId),
      ...fact('model', v.model),
      ...list('resources', strs(v.rids)),
    ];
  },
};

/**
 * Деталь сигнала на экран. Прозу известного сигнала не трогают; JSON известного — факты по его
 * форме; у неизвестного сигнала JSON-объект или массив — ключи, иначе текст дословно.
 */
export function signalDetail(signal: string, detail: string): SignalDetailView {
  if (detail === '') return { form: 'none' };
  const known = isSignalId(signal) ? SIGNAL_VIEW[signal] : null;
  if (known?.detail === 'prose') return { form: 'text', text: detail };
  const looksJson = /^\s*[[{]/.test(detail);
  const parsed = known || looksJson ? parseJson(detail) : undefined;
  if (parsed === undefined) return { form: 'text', text: detail };
  const read = known ? FACTS[signal as JsonSignal] : undefined;
  const facts = read ? read(parsed) : null;
  if (facts) return facts.length > 0 ? { form: 'facts', facts } : { form: 'none' };
  return { form: 'keys', keys: signalKeys(parsed) };
}
