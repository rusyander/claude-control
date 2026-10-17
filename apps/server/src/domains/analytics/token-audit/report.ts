import type { SessionAudit } from './token-audit.types.ts';

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
}

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);
const sumValues = (record: Record<string, number>): number => sum(Object.values(record));

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
      `  ↳ агент ${sub.id.slice(0, 22)}: вызовы ${s.calls} · чтение ${k(s.cacheRead)} · запись ${k(s.cacheWrite)} · вывод ${k(s.output)} · наибольший контекст ${k(s.maxContext)}`,
    );
  }
  return lines;
}

/** Строка суммы — то же, что у сессии, по всем сразу. */
export function formatTotal(h: Headline, sessions: number): string[] {
  return [
    `═ ИТОГО ${sessions} сесс.: вызовы ${h.calls} · чтение кеша ${k(h.cacheRead)} · запись ${k(h.cacheWrite)} (часовая ${pct(h.cacheWrite1h, h.cacheWrite)}) · вывод ${k(h.output)}`,
    `  первый контекст в среднем ${k(h.firstContext)} · средний ${k(h.averageContext)} · наибольший ${k(h.maxContext)} · сжатий ${h.compactions}`,
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
