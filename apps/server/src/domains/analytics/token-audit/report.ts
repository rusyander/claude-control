import type { SessionAudit } from './token-audit.types.ts';
import { unionMs } from './time.ts';

/**
 * Отчёт измерителя: заголовочные числа сессии, сумма по разделению, текст для
 * человека, сравнение с эталоном и потолки для CI.
 */

/** Числа, по которым план экономии сравнивает прогоны «до» и «после». */
export interface Headline {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  output: number;
  /** Постоянная часть: контекст первого вызова (у суммы — средний по сессиям). */
  firstContext: number;
  averageContext: number;
  maxContext: number;
  compactions: number;
  rereadFiles: number;
  unchangedRereads: number;
  /** Доля чтения кеша на вызовах «одна короткая команда», проценты. */
  tinyBashShare: number;
  hookContextChars: number;
  spills: number;
  hookDenials: number;
  wholeFileWrites: number;
  subagentCalls: number;
  subagentCacheRead: number;
  /** По часам: первая запись → последняя, вложенные агенты включены, мс. */
  wallMs: number;
  /** Хоть кто-то занят (модель или инструмент), параллельное — один раз, мс. */
  activeMs: number;
  /** Сумма занятости по агентам — больше стены, когда агенты шли разом, мс. */
  agentTimeMs: number;
  /** Из суммы: модель пишет и идут инструменты, мс. */
  modelMs: number;
  toolMs: number;
  /** Метрики плана экономии (`economy.ts`): доли — у самой сессии, счётчики — с агентами. */
  prefixShare: number;
  singleRunShare: number;
  wholeCheckRuns: number;
  wholeCheckMinutes: number;
  capKills: number;
  capKillMinutes: number;
  sleepMinutes: number;
  falseRules: number;
}

type EconomyHead = Pick<
  Headline,
  | 'prefixShare'
  | 'singleRunShare'
  | 'wholeCheckRuns'
  | 'wholeCheckMinutes'
  | 'capKills'
  | 'capKillMinutes'
  | 'sleepMinutes'
  | 'falseRules'
>;
const ECONOMY_COUNTS = [
  'wholeCheckRuns',
  'wholeCheckMinutes',
  'capKills',
  'capKillMinutes',
  'sleepMinutes',
  'falseRules',
] as const;

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const sumValues = (record: Record<string, number>): number => sum(Object.values(record));

/** Время всего дерева сессий: стена, объединение занятости и суммы по агентам. */
function timeOf(
  audits: SessionAudit[],
): Pick<Headline, 'wallMs' | 'activeMs' | 'agentTimeMs' | 'modelMs' | 'toolMs'> {
  const all: SessionAudit[] = [];
  const walk = (audit: SessionAudit): void => {
    all.push(audit);
    audit.subagents.forEach(walk);
  };
  audits.forEach(walk);
  const times = all.flatMap((audit) => (audit.time ? [audit.time] : []));
  if (times.length === 0) return { wallMs: 0, activeMs: 0, agentTimeMs: 0, modelMs: 0, toolMs: 0 };
  return {
    wallMs: Math.max(...times.map((t) => t.lastMs)) - Math.min(...times.map((t) => t.firstMs)),
    activeMs: unionMs(times.flatMap((t) => t.busy)),
    agentTimeMs: sum(times.map((t) => unionMs(t.busy))),
    modelMs: sum(times.map((t) => t.modelMs)),
    toolMs: sum(times.map((t) => t.toolMs)),
  };
}

/** `3725000` → `62м05с`: отчёт читают глазами. */
const minutes = (ms: number): string =>
  `${Math.floor(ms / 60_000)}м${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}с`;

function timeLine(h: Headline): string {
  return `  время: по часам ${minutes(h.wallMs)} · занят хоть кто-то ${minutes(h.activeMs)} · сумма по агентам ${minutes(h.agentTimeMs)} (модель ${minutes(h.modelMs)}, инструменты ${minutes(h.toolMs)})`;
}

/** Метрики экономии сессии; счётчики вложенных агентов прибавлены. */
function economyHead(audit: SessionAudit, subs: Headline[]): EconomyHead {
  const e = audit.economy;
  const own: EconomyHead = {
    prefixShare: e?.prefixShare ?? 0,
    singleRunShare: e?.singleRunShare ?? 0,
    wholeCheckRuns: e?.wholeChecks.runs ?? 0,
    wholeCheckMinutes: e?.wholeChecks.minutes ?? 0,
    capKills: e?.capKills.count ?? 0,
    capKillMinutes: e?.capKills.minutes ?? 0,
    sleepMinutes: e?.sleepMinutes ?? 0,
    falseRules: e?.falseRules ?? 0,
  };
  for (const key of ECONOMY_COUNTS) own[key] += sum(subs.map((s) => s[key]));
  return own;
}

function economyLine(h: Headline): string {
  return `  экономия: постоянная часть ${h.prefixShare}% чтения · одиночные шаги подряд ${h.singleRunShare}% · проверки на весь проект ${h.wholeCheckRuns} (${h.wholeCheckMinutes} мин) · убито по таймауту ${h.capKills} (${h.capKillMinutes} мин) · sleep ${h.sleepMinutes} мин · правила на черновиках ${h.falseRules}`;
}

/** Сессия вместе с её вложенными агентами — так её видит окно лимитов. */
export function headline(audit: SessionAudit): Headline {
  const subs = audit.subagents.map(headline);
  return {
    calls: audit.calls,
    input: audit.totals.input,
    cacheRead: audit.totals.cacheRead,
    cacheWrite: audit.totals.cacheWrite,
    cacheWrite1h: audit.totals.cacheWrite1h,
    output: audit.totals.output,
    firstContext: audit.constant?.firstContext ?? 0,
    averageContext: audit.averageContext,
    maxContext: audit.maxContext,
    compactions: audit.compactions,
    rereadFiles: audit.rereads.files,
    unchangedRereads: audit.rereads.unchanged,
    tinyBashShare: audit.totals.cacheRead
      ? Math.round((100 * audit.tinyBash.cacheRead) / audit.totals.cacheRead)
      : 0,
    hookContextChars: sumValues(audit.hookContext),
    spills: audit.spills,
    hookDenials: sumValues(audit.hookDenials),
    wholeFileWrites: audit.outputChars.wholeFileWrites,
    subagentCalls: sum(subs.map((s) => s.calls + s.subagentCalls)),
    subagentCacheRead: sum(subs.map((s) => s.cacheRead + s.subagentCacheRead)),
    ...timeOf([audit]),
    ...economyHead(audit, subs),
  };
}

/**
 * Сумма по нескольким сессиям. Счётчики складываются; контексты — средние по
 * вызовам (средний контекст) и по сессиям (постоянная часть), наибольший —
 * наибольший: сумма контекстов ничего не значит.
 */
export function totalHeadline(audits: SessionAudit[]): Headline {
  const heads = audits.map(headline);
  const calls = sum(heads.map((h) => h.calls));
  const tiny = sum(audits.map((a) => a.tinyBash.cacheRead));
  const read = sum(heads.map((h) => h.cacheRead));
  const add = (key: keyof Headline): number => sum(heads.map((h) => h[key]));
  return {
    calls,
    input: add('input'),
    cacheRead: read,
    cacheWrite: add('cacheWrite'),
    cacheWrite1h: add('cacheWrite1h'),
    output: add('output'),
    firstContext: heads.length ? Math.round(add('firstContext') / heads.length) : 0,
    averageContext: calls
      ? Math.round(sum(audits.map((a) => a.averageContext * a.calls)) / calls)
      : 0,
    maxContext: Math.max(0, ...heads.map((h) => h.maxContext)),
    compactions: add('compactions'),
    rereadFiles: add('rereadFiles'),
    unchangedRereads: add('unchangedRereads'),
    tinyBashShare: read ? Math.round((100 * tiny) / read) : 0,
    hookContextChars: add('hookContextChars'),
    spills: add('spills'),
    hookDenials: add('hookDenials'),
    wholeFileWrites: add('wholeFileWrites'),
    subagentCalls: add('subagentCalls'),
    subagentCacheRead: add('subagentCacheRead'),
    // Сессии разделения идут разом: стена и занятость — по всем вместе, не сумма.
    ...timeOf(audits),
    // Доли — средние по вызовам, как средний контекст.
    prefixShare: calls ? Math.round(sum(heads.map((h) => h.prefixShare * h.calls)) / calls) : 0,
    singleRunShare: calls
      ? Math.round(sum(heads.map((h) => h.singleRunShare * h.calls)) / calls)
      : 0,
    ...(Object.fromEntries(ECONOMY_COUNTS.map((key) => [key, add(key)])) as Pick<
      Headline,
      (typeof ECONOMY_COUNTS)[number]
    >),
  };
}

const k = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
const pct = (part: number, whole: number): string =>
  whole ? `${Math.round((100 * part) / whole)}%` : '0%';
const top = (record: Record<string, number>, n: number, fmt = k): string =>
  Object.entries(record)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([key, value]) => `${key} ${fmt(value)}`)
    .join(', ');

/** Текст по одной сессии: каждое слагаемое формулы расхода отдельной строкой. */
export function formatSession(audit: SessionAudit): string[] {
  const h = headline(audit);
  const lines = [
    `■ ${audit.id.slice(0, 8)} [${audit.kind}]${audit.title ? ` ${audit.title}` : ''} ${audit.firstTimestamp?.slice(0, 16) ?? ''}`,
    `  вызовы ${h.calls} · чтение кеша ${k(h.cacheRead)} · запись ${k(h.cacheWrite)} (часовая ${pct(h.cacheWrite1h, h.cacheWrite)}) · вывод ${k(h.output)} · вход ${k(h.input)}`,
    `  контекст: первый ${k(h.firstContext)} · средний ${k(h.averageContext)} · наибольший ${k(h.maxContext)} · сжатий ${h.compactions}`,
    ...(h.wallMs ? [timeLine(h)] : []),
    ...(audit.economy ? [economyLine(h)] : []),
  ];
  const c = audit.constant;
  if (c && audit.kind === 'claude') {
    const instructions = c.instructions
      .map(
        (file) =>
          `${file.path.replace(/\\/g, '/').split('/').slice(-2).join('/')} ${k(file.chars)}`,
      )
      .join(', ');
    lines.push(
      `  постоянная часть (знаки): задание ${k(c.taskChars)} · навыки ${k(c.skillChars)} (${c.skillCount}) · MCP-указания ${k(c.mcpInstructionChars)} · агенты ${k(c.agentListingChars)}`,
      `  инструкции: ${instructions || '—'}`,
      `  отложенные инструменты ${c.deferredTools}: ${top(c.deferredBySource, 8, String)}`,
    );
  }
  const read = audit.totals.cacheRead;
  lines.push(
    `  шаги (вызовы/доля чтения): ${Object.entries(audit.steps)
      .sort((a, b) => b[1].cacheRead - a[1].cacheRead)
      .map(([name, s]) => `${name} ${s.calls}/${pct(s.cacheRead, read)}`)
      .join(' · ')}`,
    `  инструменты (ответы, знаки): ${top(
      Object.fromEntries(
        Object.entries(audit.tools).map(([n, t]) => [`${n}×${t.calls}`, t.resultChars]),
      ),
      8,
    )}`,
    `  повторы: файлов открыто 2+ раз ${h.rereadFiles}, повторов без правки между ${h.unchangedRereads} · одинаковых Bash ${audit.repeatedBash} · одиночных коротких Bash ${audit.tinyBash.calls} = ${h.tinyBashShare}% чтения · ожиданий ${audit.pollCommands}`,
  );
  if (audit.rereads.top.length > 0) {
    lines.push(
      `    чаще всего: ${audit.rereads.top.map((t) => `${t.views}× ${t.path}`).join(' | ')}`,
    );
  }
  if (audit.kind === 'claude') {
    lines.push(
      `  хуки: подмешано ${k(h.hookContextChars)} знаков (${top(audit.hookContext, 4)}) · отказов ${h.hookDenials}${h.hookDenials ? ` (${top(audit.hookDenials, 4, String)})` : ''} · выгружено в файл ${h.spills}`,
      `  вывод (знаки): текст ${k(audit.outputChars.text)} · входы инструментов ${k(audit.outputChars.toolInput)} · файлов целиком ${h.wholeFileWrites} на ${k(audit.outputChars.wholeFileChars)} · картинок ${audit.images}`,
    );
    const spikes = audit.cacheWriteSpikes;
    if (spikes.length > 0) {
      lines.push(
        `  всплески записи >15k: ${spikes.length} на ${k(sum(spikes.map((s) => s.write)))} — ${spikes
          .slice(0, 6)
          .map(
            (s) =>
              `${s.timestamp?.slice(11, 16) ?? '?'} ${k(s.write)} ${s.causes.join('+') || '?'}`,
          )
          .join(' | ')}`,
      );
    }
  }
  for (const sub of audit.subagents) {
    const s = headline(sub);
    lines.push(
      `  ↳ агент ${sub.id.slice(0, 22)}: вызовы ${s.calls} · чтение ${k(s.cacheRead)} · запись ${k(s.cacheWrite)} · вывод ${k(s.output)} · наибольший контекст ${k(s.maxContext)}${s.wallMs ? ` · по часам ${minutes(s.wallMs)}, занят ${minutes(s.activeMs)}` : ''}`,
    );
  }
  return lines;
}

/** Строка суммы — то же, что у сессии, по всем сразу. */
export function formatTotal(h: Headline, sessions: number): string[] {
  return [
    `═ ИТОГО ${sessions} сесс.: вызовы ${h.calls} · чтение кеша ${k(h.cacheRead)} · запись ${k(h.cacheWrite)} (часовая ${pct(h.cacheWrite1h, h.cacheWrite)}) · вывод ${k(h.output)}`,
    `  первый контекст в среднем ${k(h.firstContext)} · средний ${k(h.averageContext)} · наибольший ${k(h.maxContext)} · сжатий ${h.compactions}`,
    ...(h.wallMs ? [timeLine(h)] : []),
    economyLine(h),
    `  вложенные агенты: вызовы ${h.subagentCalls} · чтение кеша ${k(h.subagentCacheRead)}`,
    `  файлов открыто 2+ раз ${h.rereadFiles} · повторов без правки между ${h.unchangedRereads} · короткие Bash ${h.tinyBashShare}% чтения · хуки ${k(h.hookContextChars)} знаков, отказов ${h.hookDenials}, выгрузок ${h.spills} · файлов целиком ${h.wholeFileWrites}`,
  ];
}

/** Сравнение с эталоном: каждое число «было → стало (±%)». */
export function compareHeadlines(base: Headline, now: Headline): string[] {
  return (Object.keys(base) as Array<keyof Headline>).map((key) => {
    const before = base[key];
    const after = now[key];
    const delta = before ? Math.round((100 * (after - before)) / before) : after ? 100 : 0;
    return `  ${key.padEnd(18)} ${String(before).padStart(11)} → ${String(after).padStart(11)}  ${delta > 0 ? '+' : ''}${delta}%`;
  });
}

/** Потолки для CI: `{ firstContext: 45000 }` → нарушенные строки, пусто — в норме. */
export function checkLimits(
  h: Headline,
  limits: Partial<Record<keyof Headline, number>>,
): string[] {
  const broken: string[] = [];
  for (const [key, limit] of Object.entries(limits) as Array<[keyof Headline, number]>) {
    if (!(key in h)) broken.push(`${key}: такого числа нет в отчёте`);
    else if (h[key] > limit) broken.push(`${key} ${h[key]} > потолка ${limit}`);
  }
  return broken;
}
