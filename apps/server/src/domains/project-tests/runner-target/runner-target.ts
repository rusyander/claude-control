import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { RunnerTarget, StandTargets } from './runner-target.types.ts';

export type { RunnerTarget, StandTargets } from './runner-target.types.ts';

/**
 * Куда на самом деле ходит раннер (M3, g5 27.10).
 *
 * `run --health http://localhost:5173` записал кейсы Playwright «заблокирован»: стенд
 * не ответил. Но наборы шли на `process.env.E2E_BASE_URL ?? 'https://stand.example.com'` —
 * проверялся адрес, которого раннер не касается. Здесь — адреса из `playwright.config.*`
 * пакета: `baseURL` проекта (у его `testDir`) или общий, переменная окружения первой,
 * иначе значение по умолчанию из самого конфига. Чтение текстовое: конфиг не исполняется
 * (его код — код ветки, и запуск ради адреса тянул бы зависимости).
 */

const CONFIGS = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
  'playwright.config.cjs',
];

/** Конфиг Playwright в каталоге пакета или `undefined`. */
function playwrightConfigIn(dir: string): string | undefined {
  const name = CONFIGS.find((item) => existsSync(join(dir, item)));
  return name ? join(dir, name) : undefined;
}

interface ObjectSpan {
  start: number;
  end: number;
  depth: number;
}

/** Объектные литералы текста — скобки вне строк и комментариев. */
function objectSpans(text: string): ObjectSpan[] {
  const spans: ObjectSpan[] = [];
  const open: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '/' && next === '/') {
      index = text.indexOf('\n', index);
      if (index < 0) break;
      continue;
    }
    if (char === '/' && next === '*') {
      index = text.indexOf('*/', index + 2) + 1;
      if (index <= 0) break;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < text.length && text[index] !== char; index += 1)
        if (text[index] === '\\') index += 1;
      continue;
    }
    if (char === '{') open.push(index);
    else if (char === '}' && open.length) {
      const start = open.pop()!;
      spans.push({ start, end: index, depth: open.length });
    }
  }
  return spans;
}

/** Вложенные объекты убраны: свойство — этого уровня, а не `use: {…}` соседа. */
function ownLevel(text: string, span: ObjectSpan, spans: ObjectSpan[]): string {
  let out = text.slice(span.start + 1, span.end);
  const inner = spans
    .filter(
      (item) => item.depth === span.depth + 1 && item.start > span.start && item.end < span.end,
    )
    .sort((a, b) => b.start - a.start);
  for (const item of inner)
    out =
      out.slice(0, item.start - span.start - 1) +
      ' '.repeat(item.end - item.start + 1) +
      out.slice(item.end - span.start);
  return out;
}

const STRING = /'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`$\\]*)`/g;
const ENV_NAME = /process\.env(?:\.([A-Za-z_]\w*)|\[\s*['"]([^'"]+)['"]\s*\])/g;

/**
 * Выражение `baseURL:` до конца свойства: запятая вне скобок и строк или конец строки.
 * `use: { baseURL: SHARED, trace: 'off' }` в одну строку иначе давал выражение
 * «SHARED, trace: 'off'», и адрес не находился. Строки-комментарии не в счёт.
 */
function baseUrlExpression(text: string): string | undefined {
  const plain = text.replace(/(^|\s)\/\/[^\n]*/g, '$1');
  const match = /\bbaseURL\s*:\s*([^\n]+)/.exec(plain);
  if (!match) return undefined;
  const rest = match[1]!;
  let depth = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < rest.length && rest[index] !== char; index += 1)
        if (rest[index] === '\\') index += 1;
      continue;
    }
    if (char === '(' || char === '[') depth += 1;
    else if (char === ')' || char === ']') depth -= 1;
    else if (char === ',' && depth === 0) return rest.slice(0, index).trim();
  }
  return rest.trim();
}

/** Константа модуля `const NAME = …` — выражение адреса бывает вынесено в неё. */
function constantOf(text: string, name: string): string | undefined {
  const match = new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*([^\\n;]+)`).exec(text);
  return match?.[1]?.trim();
}

/** Адрес выражения: первая заданная переменная окружения, иначе строка по умолчанию. */
function resolveExpression(
  expression: string,
  text: string,
  env: NodeJS.ProcessEnv,
): { url?: string; from: string } | undefined {
  let source = expression;
  if (/^[A-Za-z_]\w*$/.test(source)) source = constantOf(text, source) ?? source;
  const names = [...source.matchAll(ENV_NAME)].map((match) => (match[1] ?? match[2])!);
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return { url: value, from: `${name}` };
  }
  const literals = [...source.matchAll(STRING)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '')
    .filter((value) => /^https?:\/\//.test(value));
  const fallback = literals.at(-1);
  if (fallback)
    return {
      url: fallback,
      from: names.length ? `${names.join(', ')} не задан — по умолчанию конфига` : 'конфиг',
    };
  return names.length ? { from: `${names.join(', ')} не задан` } : undefined;
}

/**
 * Цели конфига: проект с `testDir` — свой адрес (или общий, если своего нет), общий —
 * у файлов вне проектов. `testDir` — от каталога конфига.
 */
export function playwrightTargets(configText: string, env: NodeJS.ProcessEnv): RunnerTarget[] {
  const spans = objectSpans(configText);
  const top = spans
    .filter((span) => span.depth === 0)
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  const levels = spans.map((span) => ({ span, own: ownLevel(configText, span, spans) }));
  // Проект — объект со своим `testDir`, кроме самого конфига (у него `testDir` — общий).
  const projects = levels.filter(
    ({ span, own }) => /\btestDir\s*:/.test(own) && !(top && span.start === top.start),
  );
  const inProject = (span: ObjectSpan) =>
    projects.some(({ span: project }) => span.start >= project.start && span.end <= project.end);
  // Общие адреса — `baseURL` вне объектов с `testDir`: `use` конфига и проекты-браузеры без
  // своего каталога; файлу вне проектов достаются все они.
  const shared = levels
    .filter(({ span, own }) => !inProject(span) && /\bbaseURL\s*:/.test(own))
    .map(({ own }) => baseUrlExpression(own))
    .filter((expression): expression is string => Boolean(expression))
    .map((expression) => resolveExpression(expression, configText, env))
    .filter((target): target is { url?: string; from: string } => Boolean(target));
  const asTarget = (resolved: { url?: string; from: string }, testDir?: string): RunnerTarget => ({
    ...(testDir !== undefined ? { testDir } : {}),
    ...(resolved.url ? { url: resolved.url } : {}),
    from: resolved.from,
  });
  const targets: RunnerTarget[] = [];
  for (const { span, own } of projects) {
    const dir = /\btestDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(own)?.[1];
    const testDir = dir
      ? posix.normalize(dir.replace(/\\/g, '/')).replace(/^\.\/?|\/$/g, '')
      : undefined;
    const expression = baseUrlExpression(configText.slice(span.start, span.end + 1));
    const resolved = expression ? resolveExpression(expression, configText, env) : undefined;
    // Своего адреса нет — проект идёт на общий.
    for (const item of resolved ? [resolved] : shared) targets.push(asTarget(item, testDir));
  }
  for (const item of shared) targets.push(asTarget(item));
  return targets;
}

/**
 * Адреса стенда для файлов кейсов одного пакета Playwright. `files` — от корня пакета.
 * Файл под `testDir` проекта — адреса этих проектов; ни под одним — общий адрес.
 */
export function standTargets(
  packageDir: string,
  files: readonly string[],
  env: NodeJS.ProcessEnv,
): StandTargets {
  const config = playwrightConfigIn(packageDir);
  if (!config) return { config: undefined, urls: [], unresolved: [] };
  const text = readFileSync(config, 'utf8');
  const targets = playwrightTargets(text, env);
  const urls = new Map<string, string>();
  const unresolved = new Set<string>();
  for (const file of files) {
    const path = file.replace(/\\/g, '/');
    const own = targets.filter(
      (target) =>
        target.testDir !== undefined &&
        (target.testDir === '' || path === target.testDir || path.startsWith(`${target.testDir}/`)),
    );
    const chosen = own.length ? own : targets.filter((target) => target.testDir === undefined);
    for (const target of chosen) {
      if (target.url) urls.set(target.url, target.from);
      else unresolved.add(target.from);
    }
  }
  return {
    config,
    urls: [...urls].map(([url, from]) => ({ url, from })),
    unresolved: [...unresolved],
    webServer: /\bwebServer\s*:/.test(text),
  };
}

/** Один стенд: схема, хост и порт; `localhost`, `127.0.0.1` и `[::1]` — один хост. */
export function sameStand(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    const host = (url: URL) =>
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'loopback' : url.hostname;
    return (
      left.protocol === right.protocol && host(left) === host(right) && left.port === right.port
    );
  } catch {
    return false;
  }
}
