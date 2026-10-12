import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { DbConnection, DbConnectionSource, DbUnsupported } from '@agentdeck/contracts';
import { readDotenvVars } from '../../../lib/dotenv-file/dotenv-file.ts';
import type {
  ComposeDbInput,
  DbTarget,
  FoundSources,
  ParsedTarget,
  ResolvedConnection,
} from '../database.types.ts';
import { readComposeService } from './compose.ts';
import { findInEnv } from './env.ts';
import { findInSpring, readProperties, readYamlProperties } from './spring.ts';
import { isLoopbackHost } from './url.ts';

/**
 * Все базы проекта, которые панель может назвать: Compose, `.env*`, Spring и
 * свои подключения человека. Ничего не угадывает и ничего не пишет — только
 * читает файлы проекта.
 */

/** Каталоги, где ищем: корень, его подпапки и пакеты монорепы — не глубже. */
const NESTED = ['apps', 'services', 'packages', 'backend', 'server', 'cmd'];
const SKIP = new Set([
  'node_modules',
  'vendor',
  'target',
  'build',
  'dist',
  'out',
  'bin',
  'obj',
  'venv',
]);
const MAX_DIRS = 80;

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.dev'];
/** Шаблоны — только там, где настоящего `.env` нет: в шаблоне часто заглушки. */
const ENV_TEMPLATES = ['.env.example', '.env.sample', '.env.template', 'env.example'];
const SPRING_DIR = join('src', 'main', 'resources');

const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

const childDirs = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith('.') && !SKIP.has(entry.name),
      )
      .map((entry) => join(dir, entry.name));
  } catch {
    return [];
  }
};

export function projectDirs(root: string): string[] {
  const dirs = [root];
  for (const child of childDirs(root)) {
    dirs.push(child);
    if (NESTED.includes(relative(root, child))) dirs.push(...childDirs(child));
  }
  return dirs.slice(0, MAX_DIRS);
}

const readText = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
};

/** Переменные одного `.env`. Файл не в формате dotenv — молча пропускаем. */
function readEnvFile(path: string): Record<string, string> {
  const text = readText(path);
  if (text === undefined) return {};
  try {
    return Object.fromEntries(readDotenvVars(text).map((item) => [item.key, item.value]));
  } catch {
    return {};
  }
}

const rel = (root: string, path: string): string =>
  relative(root, path).split('\\').join('/') || '.';

/** Ключ одинаковой базы: петлевые адреса равны между собой. */
const sameDbKey = (target: DbTarget): string =>
  `${isLoopbackHost(target.host) ? 'loopback' : target.host.toLowerCase()}:${target.port}/${target.database}@${target.user}`;

interface Draft {
  id: string;
  source: DbConnectionSource;
  label: string;
  origin: string;
  parsed: ParsedTarget;
  composeService?: string;
  composeState?: DbConnection['composeState'];
}

function toConnection(
  draft: Draft & { parsed: { kind: 'postgres'; target: DbTarget } },
): ResolvedConnection {
  const { target } = draft.parsed;
  return {
    info: {
      id: draft.id,
      source: draft.source,
      engine: 'postgres',
      label: draft.label,
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      hasPassword: Boolean(target.password),
      origin: draft.origin,
      remote: !isLoopbackHost(target.host),
      ...(draft.composeService ? { composeService: draft.composeService } : {}),
      ...(draft.composeState ? { composeState: draft.composeState } : {}),
    },
    ...(target.password ? { password: target.password } : {}),
  };
}

export function findConnections(
  root: string,
  compose: ComposeDbInput | undefined,
  manual: ResolvedConnection[] = [],
): FoundSources {
  const drafts: Draft[] = [];
  const unsupported: DbUnsupported[] = [];
  /** Имя сервиса Compose → куда он опубликован: `.env` приложения в контейнере пишет `db:5432`. */
  const published = new Map<string, { inner: number; target: DbTarget; service: string }>();

  for (const service of compose?.services ?? []) {
    const verdict = readComposeService(service);
    if (!verdict) continue;
    const origin = `${compose?.file ?? 'compose'} → ${service.name}`;
    if (verdict.kind === 'other') {
      unsupported.push({ origin, engine: verdict.engine, reason: 'engine' });
      continue;
    }
    if (verdict.kind === 'no-port') {
      unsupported.push({ origin, engine: 'postgres', reason: 'no-port' });
      continue;
    }
    published.set(service.name, {
      inner: Number(service.environment.PGPORT) || 5432,
      target: verdict.target,
      service: service.name,
    });
    drafts.push({
      id: `compose:${service.name}`,
      source: 'compose',
      label: service.name,
      origin,
      parsed: verdict,
      composeService: service.name,
      ...(service.state ? { composeState: service.state } : {}),
    });
  }

  /** Адрес `db:5432` из контейнерного `.env` — это опубликованный порт того же сервиса. */
  const throughCompose = (draft: Draft): Draft => {
    if (draft.parsed.kind !== 'postgres') return draft;
    const hit = published.get(draft.parsed.target.host);
    if (!hit || hit.inner !== draft.parsed.target.port) return draft;
    const service = compose?.services.find((item) => item.name === hit.service);
    return {
      ...draft,
      parsed: {
        kind: 'postgres',
        target: { ...draft.parsed.target, host: hit.target.host, port: hit.target.port },
      },
      composeService: hit.service,
      ...(service?.state ? { composeState: service.state } : {}),
    };
  };

  for (const dir of projectDirs(root)) {
    const dirLabel = dir === root ? '' : ` · ${rel(root, dir)}`;
    const real = ENV_FILES.map((name) => join(dir, name)).filter((path) => existsSync(path));
    const envFiles =
      real.length > 0
        ? real
        : ENV_TEMPLATES.map((name) => join(dir, name)).filter((path) => existsSync(path));
    const merged: Record<string, string> = {};
    for (const file of envFiles) {
      const vars = readEnvFile(file);
      Object.assign(merged, vars);
      for (const finding of findInEnv(vars)) {
        const origin = `${rel(root, file)} → ${finding.key}`;
        if (finding.parsed.kind === 'other') {
          unsupported.push({ origin, engine: finding.parsed.engine, reason: 'engine' });
          continue;
        }
        drafts.push(
          throughCompose({
            id: `env:${rel(root, file)}:${finding.key}`,
            source: 'env',
            label: `${finding.key}${dirLabel}`,
            origin,
            parsed: finding.parsed,
          }),
        );
      }
    }

    const springDir = join(dir, SPRING_DIR);
    if (!isDir(springDir)) continue;
    let names: string[];
    try {
      names = readdirSync(springDir).filter((name) =>
        /^application(-[\w.-]+)?\.(properties|ya?ml)$/.test(name),
      );
    } catch {
      names = [];
    }
    for (const name of names.sort()) {
      const file = join(springDir, name);
      const text = readText(file) ?? '';
      const props = name.endsWith('.properties') ? readProperties(text) : readYamlProperties(text);
      // Подстановки — из `.env` того же каталога. Окружение самой панели сюда не
      // идёт: её `DB_HOST` не имеет отношения к проекту.
      const parsed = findInSpring(props, merged);
      if (!parsed) continue;
      const origin = `${rel(root, file)} → spring.datasource`;
      if (parsed.kind === 'other') {
        unsupported.push({ origin, engine: parsed.engine, reason: 'engine' });
        continue;
      }
      drafts.push(
        throughCompose({
          id: `spring:${rel(root, file)}`,
          source: 'spring',
          label: `Spring · ${name}${dirLabel}`,
          origin,
          parsed,
        }),
      );
    }
  }

  // Одна и та же база, названная в compose, в `.env` и в Spring, — одна строка;
  // пароль берём у первого, кто его знает.
  const byKey = new Map<string, ResolvedConnection>();
  for (const draft of drafts) {
    if (draft.parsed.kind !== 'postgres') continue;
    const connection = toConnection({ ...draft, parsed: draft.parsed });
    const key = sameDbKey(draft.parsed.target);
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, connection);
    } else if (!kept.password && connection.password) {
      kept.password = connection.password;
      kept.info.hasPassword = true;
    }
  }
  const seenUnsupported = new Set<string>();
  return {
    // Свои подключения человека не схлопываются: он завёл их нарочно.
    connections: [...byKey.values(), ...manual],
    unsupported: unsupported.filter((item) => {
      const key = `${item.origin}|${item.engine}`;
      if (seenUnsupported.has(key)) return false;
      seenUnsupported.add(key);
      return true;
    }),
  };
}
