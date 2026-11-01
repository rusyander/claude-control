import type { EstimateReply } from '@agentdeck/contracts/core/estimate';
import type { CliWhere, RejectedRow, RoadView } from './launch.types';

/**
 * Ответ оценки → то, что показывает экран запуска: дороги предпроверки с местом CLI, правки
 * сценария, которые ядро отвергло (расширение из репозитория, 06), числа оценки. Тексты ядра
 * остаются дословными: экран переводит только свои подписи, причины — как их записало ядро.
 */

const FIX_TAIL = ' — fix: ';

function splitFix(detail: string): { detail: string; fix: string | null } {
  const at = detail.lastIndexOf(FIX_TAIL);
  if (at < 0) return { detail, fix: null };
  return { detail: detail.slice(0, at), fix: detail.slice(at + FIX_TAIL.length) };
}

const VIA = /\s*\((override|search)\)\s*$/;

/**
 * Строка дороги `cli` по переходникам: `claude: C:\…\claude.exe; unusable qwen: «qwen» not found
 * (searched 51 dirs)`. Найденный — путь (и чем найден, если ядро назвало), не найденный и
 * отвергнутый — со строкой ядра дословно. Части, которые не разобрать, не теряются: они идут
 * строкой «отвергнут» с исходным текстом, а не пропадают с экрана.
 */
export function parseCliDetail(detail: string): CliWhere[] {
  const out: CliWhere[] = [];
  for (const raw of splitFix(detail).detail.split('; ')) {
    const part = raw.trim();
    if (!part) continue;
    const body = part.replace(/^unusable\s+/, '');
    const colon = body.indexOf(': ');
    if (colon <= 0) {
      out.push({ adapter: '?', state: 'refused', where: null, via: null, text: part });
      continue;
    }
    const adapter = body.slice(0, colon);
    const rest = body.slice(colon + 2);
    if (/\bnot found\b/.test(rest)) {
      out.push({ adapter, state: 'absent', where: null, via: null, text: rest });
      continue;
    }
    const refused = /^«(.+)» refused: /.exec(rest);
    if (refused) {
      out.push({ adapter, state: 'refused', where: refused[1] as string, via: null, text: rest });
      continue;
    }
    if (rest.includes('adapter not in this core build') || part.startsWith('unusable ')) {
      out.push({ adapter, state: 'refused', where: null, via: null, text: rest });
      continue;
    }
    const via = VIA.exec(rest);
    out.push({
      adapter,
      state: 'found',
      where: rest.replace(VIA, ''),
      via: via ? (via[1] as 'override' | 'search') : null,
      text: rest,
    });
  }
  return out;
}

/** Дороги в порядке ядра; у `cli` — место каждого CLI. */
export function roadsOf(rows: EstimateReply['preflight']): RoadView[] {
  return rows.map((row) => {
    const { detail, fix } = splitFix(row.detail);
    return {
      road: row.road,
      status: row.status,
      detail,
      fix,
      cli: row.road === 'cli' ? parseCliDetail(row.detail) : null,
    };
  });
}

/** Значение правки для показа: строки как есть, остальное — JSON. */
function shown(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * Отвергнутые правки сценария (06: репозиторий не расширяет то, что сузил человек или ядро).
 * Каждая — строкой с уровнем, путём, значением и причиной: молча отброшенная правка выглядела бы
 * принятой.
 */
export function rejectedRows(reply: Pick<EstimateReply, 'overlay'>): RejectedRow[] {
  return reply.overlay.rejected.map((entry) => ({
    level: entry.level,
    path: entry.path,
    value: shown(entry.value),
    reason: entry.reason,
  }));
}
