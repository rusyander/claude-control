import type { LogLine } from '@agentdeck/contracts';
import { stripAnsi } from '../project-runner/log-buffer.ts';

/** Сколько строк отдаёт один опрос сервиса Compose: и первый показ, и догоняющий. */
export const COMPOSE_TAIL = 500;
export const COMPOSE_CATCH_UP = 2000;

const TIMESTAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))\s?/;
const PREFIX = /^(\S+?)\s+\|\s?/;

/**
 * Ключ сравнения времени docker: дробная часть RFC3339Nano без хвостовых нулей
 * разной длины, поэтому строки сравниваются только после добивки до 9 знаков.
 */
export function timeKey(stamp: string): string {
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)$/.exec(stamp);
  if (!match) return stamp;
  return `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}${match[3]}`;
}

/** Время в ISO с миллисекундами — как у строк целей запуска. */
function toIso(stamp: string): string | undefined {
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Префикс строки `docker compose logs` — имя контейнера без проекта (`db-1`)
 * или заданный `container_name`. Сервис узнаём по известным именам, иначе
 * отрезаем номер реплики.
 */
function serviceOf(prefix: string, services: string[]): string {
  if (services.includes(prefix)) return prefix;
  const bare = prefix.replace(/-\d+$/, '');
  return services.find((name) => name === bare) ?? bare;
}

export interface ParsedComposeLine extends LogLine {
  /** Время docker как есть — курсор следующего опроса. */
  stamp?: string;
}

/**
 * Вывод `docker compose logs --timestamps --no-color` в строки. Несколько
 * контейнеров docker печатает не вперемешку по времени, а один за другим, —
 * поэтому строки с временем упорядочиваются (стабильно, порядок внутри одного
 * контейнера сохраняется).
 */
export function parseComposeLogs(
  output: string,
  options: { withPrefix: boolean; services: string[] },
): ParsedComposeLine[] {
  const lines: ParsedComposeLine[] = [];
  for (const raw of output.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    let rest = stripAnsi(raw);
    let service: string | undefined;
    if (options.withPrefix) {
      const prefix = PREFIX.exec(rest);
      if (prefix?.[1]) {
        service = serviceOf(prefix[1], options.services);
        rest = rest.slice(prefix[0].length);
      }
    }
    const stamp = TIMESTAMP.exec(rest);
    const at = stamp?.[1] ? toIso(stamp[1]) : undefined;
    if (stamp) rest = rest.slice(stamp[0].length);
    lines.push({
      text: rest.slice(0, 4000),
      ...(at ? { at } : {}),
      ...(stamp?.[1] ? { stamp: stamp[1] } : {}),
      ...(service ? { service } : {}),
    });
  }
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      const left = a.line.stamp ? timeKey(a.line.stamp) : '';
      const right = b.line.stamp ? timeKey(b.line.stamp) : '';
      if (left === right) return a.index - b.index;
      return left < right ? -1 : 1;
    })
    .map(({ line }) => line);
}

/** Только строки строго позже курсора: `--since` у docker включает границу. */
export function afterCursor(lines: ParsedComposeLine[], cursor?: string): ParsedComposeLine[] {
  if (!cursor) return lines;
  const edge = timeKey(cursor);
  return lines.filter((line) => line.stamp !== undefined && timeKey(line.stamp) > edge);
}
