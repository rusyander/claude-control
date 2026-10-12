import type { ComposePort, ComposeService, ComposeServiceState } from '@agentdeck/contracts';

/**
 * Разбор ответов docker compose. Чистые функции — тесты кормят их тем, что
 * печатает настоящий docker (снято с Docker 29 / Compose v5), без процесса.
 */

/** Сервис, как он описан в файле (`compose config --format json`). */
export interface DeclaredService {
  name: string;
  image?: string;
  build: boolean;
  ports: ComposePort[];
  dependsOn: string[];
  /**
   * Переменные окружения сервиса после подстановки — по ним вкладка «База
   * данных» узнаёт пароль и имя базы. Наружу в `ComposeService` не уходят:
   * там бывают секреты.
   */
  environment: Record<string, string>;
}

export interface DeclaredStack {
  projectName?: string;
  services: DeclaredService[];
  volumes: string[];
}

/** Строка `compose ps --format json`: одна на контейнер. */
export interface ContainerRow {
  service: string;
  state: ComposeServiceState;
  health?: 'healthy' | 'unhealthy' | 'starting';
  status?: string;
  exitCode?: number;
  ports: ComposePort[];
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function declaredPorts(raw: unknown): ComposePort[] {
  if (!Array.isArray(raw)) return [];
  const ports: ComposePort[] = [];
  for (const item of raw) {
    const port = asRecord(item);
    const published = Number(port.published);
    const target = Number(port.target);
    if (!Number.isInteger(published) || published <= 0 || !Number.isInteger(target)) continue;
    ports.push({
      host: typeof port.host_ip === 'string' ? port.host_ip : '',
      published,
      target,
      protocol: typeof port.protocol === 'string' ? port.protocol : 'tcp',
    });
  }
  return ports;
}

function environment(raw: unknown): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(asRecord(raw))) {
    if (typeof value === 'string') env[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') env[key] = String(value);
  }
  return env;
}

function dependsOn(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === 'string');
  return Object.keys(asRecord(raw));
}

export function parseConfig(json: string): DeclaredStack {
  const doc = asRecord(JSON.parse(json));
  const services = Object.entries(asRecord(doc.services)).map(([name, raw]) => {
    const service = asRecord(raw);
    return {
      name,
      ...(typeof service.image === 'string' ? { image: service.image } : {}),
      build: service.build !== undefined && service.build !== null,
      ports: declaredPorts(service.ports),
      dependsOn: dependsOn(service.depends_on),
      environment: environment(service.environment),
    };
  });
  return {
    ...(typeof doc.name === 'string' ? { projectName: doc.name } : {}),
    services,
    volumes: Object.keys(asRecord(doc.volumes)),
  };
}

const STATES = new Set<ComposeServiceState>([
  'running',
  'exited',
  'created',
  'restarting',
  'paused',
  'dead',
]);

function liveState(raw: unknown): ComposeServiceState {
  const state = typeof raw === 'string' ? raw.toLowerCase() : '';
  // `removing` — контейнер вот-вот исчезнет; для человека он уже не работает.
  return STATES.has(state as ComposeServiceState) ? (state as ComposeServiceState) : 'exited';
}

/**
 * Опубликованные порты контейнера. Docker пишет каждый дважды — для IPv4 и
 * IPv6 (`0.0.0.0` и `::`), а неопубликованный — с нулём: оставляем по одному.
 */
function livePorts(raw: unknown): ComposePort[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const ports: ComposePort[] = [];
  for (const item of raw) {
    const port = asRecord(item);
    const published = Number(port.PublishedPort);
    if (!Number.isInteger(published) || published <= 0) continue;
    const protocol = typeof port.Protocol === 'string' ? port.Protocol : 'tcp';
    const key = `${published}/${protocol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const host = typeof port.URL === 'string' ? port.URL : '';
    ports.push({
      host: host === '::' ? '' : host,
      published,
      target: Number(port.TargetPort) || 0,
      protocol,
    });
  }
  return ports;
}

/**
 * Ответ `compose ps --format json`. Новые версии печатают объект на строку,
 * старые (до 2.21) — один массив; читаем оба.
 */
export function parsePs(text: string): ContainerRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const items: unknown[] = trimmed.startsWith('[')
    ? (JSON.parse(trimmed) as unknown[])
    : trimmed
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as unknown);
  return items.map((raw) => {
    const row = asRecord(raw);
    const health = typeof row.Health === 'string' ? row.Health.toLowerCase() : '';
    const exitCode = Number(row.ExitCode);
    return {
      service: typeof row.Service === 'string' ? row.Service : '',
      state: liveState(row.State),
      ...(health === 'healthy' || health === 'unhealthy' || health === 'starting'
        ? { health }
        : {}),
      ...(typeof row.Status === 'string' && row.Status ? { status: row.Status } : {}),
      ...(Number.isInteger(exitCode) ? { exitCode } : {}),
      ports: livePorts(row.Publishers),
    };
  });
}

/**
 * Порядок подъёма: зависимости раньше зависящих (база выше приложения), внутри
 * одного уровня — по имени. `compose config` отдаёт сервисы по алфавиту, а не
 * как в файле, так что «как написал автор» docker уже не помнит.
 */
function byStartOrder(services: DeclaredService[]): DeclaredService[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const depth = new Map<string, number>();
  const depthOf = (name: string, path: Set<string>): number => {
    const known = depth.get(name);
    if (known !== undefined) return known;
    // Цикл зависимостей docker не примет, но разбор не должен из-за него зависнуть.
    if (path.has(name)) return 0;
    path.add(name);
    const deps = byName.get(name)?.dependsOn.filter((dep) => byName.has(dep)) ?? [];
    const value = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((dep) => depthOf(dep, path)));
    path.delete(name);
    depth.set(name, value);
    return value;
  };
  return [...services].sort(
    (a, b) =>
      depthOf(a.name, new Set()) - depthOf(b.name, new Set()) || a.name.localeCompare(b.name),
  );
}

/**
 * Сервисы файла с состоянием их контейнеров, в порядке подъёма. Контейнеров у
 * сервиса несколько (`scale`) — показываем первый работающий, иначе первый.
 */
export function mergeServices(declared: DeclaredStack, rows: ContainerRow[]): ComposeService[] {
  return byStartOrder(declared.services).map((service) => {
    const own = rows.filter((row) => row.service === service.name);
    const row = own.find((item) => item.state === 'running') ?? own[0];
    const base = {
      name: service.name,
      ...(service.image ? { image: service.image } : {}),
      build: service.build,
      dependsOn: service.dependsOn,
    };
    if (!row) return { ...base, state: 'absent' as const, ports: service.ports };
    return {
      ...base,
      state: row.state,
      ...(row.state === 'running' && row.health ? { health: row.health } : {}),
      ...(row.status ? { status: row.status } : {}),
      ...(row.state !== 'running' && row.exitCode !== undefined ? { exitCode: row.exitCode } : {}),
      ports: row.state === 'running' && row.ports.length > 0 ? row.ports : service.ports,
    };
  });
}
