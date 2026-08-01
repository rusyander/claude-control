import type {
  CompareEntry,
  CompareSection,
  CompareSectionResult,
  CompareSide,
  CompareState,
  ProviderCompareResponse,
} from '@claude-control/contracts';
import { getProvider } from '../../providers/registry.ts';
import { envSide, instructionsSide, mcpSide, permissionsSide } from './sections.ts';
import { CompareRequestError, type CompareDeps, type Row, type SideRead } from './types.ts';

export function compareProviders(
  leftId: string,
  rightId: string,
  deps: CompareDeps,
): ProviderCompareResponse {
  if (leftId === rightId) {
    throw new CompareRequestError('Сравнивать провайдера с самим собой нечего.');
  }

  const left = getProvider(leftId);
  const right = getProvider(rightId);

  const sections: CompareSectionResult[] = [
    buildSection('mcp', leftId, rightId, deps, mcpSide, { comparable: true, migratable: true }),
    buildSection('env', leftId, rightId, deps, envSide, {
      comparable: true,
      migratable: false,
      note: 'Переменные не переносятся: их значения — обычно ключи и токены, а секреты панель в чужие конфигурации не пишет.',
    }),
    buildSection('permissions', leftId, rightId, deps, permissionsSide, {
      comparable: false,
      migratable: false,
      note: 'У каждого CLI своя модель согласований. Совпадение имён ключей не означает совпадения смысла, поэтому права показаны рядом, но не переносятся.',
    }),
    buildSection('instructions', leftId, rightId, deps, instructionsSide, {
      comparable: true,
      migratable: true,
    }),
  ];

  return {
    left: { providerId: left.id, providerName: left.name },
    right: { providerId: right.id, providerName: right.name },
    sections,
  };
}

function buildSection(
  section: CompareSection,
  leftId: string,
  rightId: string,
  deps: CompareDeps,
  read: (providerId: string, deps: CompareDeps) => SideRead,
  meta: { comparable: boolean; migratable: boolean; note?: string },
): CompareSectionResult {
  const left = read(leftId, deps);
  const right = read(rightId, deps);

  return {
    section,
    left: sideOf(leftId, left),
    right: sideOf(rightId, right),
    entries: compareRows(left, right, meta.migratable),
    comparable: meta.comparable,
    // Переносить можно, только если раздел прочитан С ОБЕИХ сторон: иначе
    // «перенести» означало бы «угадать, куда».
    migratable: meta.migratable && left.supported && right.supported,
    note: meta.note,
  };
}

function sideOf(providerId: string, read: SideRead): CompareSide {
  const provider = getProvider(providerId);
  return {
    providerId: provider.id,
    providerName: provider.name,
    supported: read.supported,
    filePath: read.filePath,
    note: read.note,
  };
}

/**
 * Свести две стороны в список записей. Пустая сторона (раздел не поддержан) не
 * порождает «только слева» на весь список другой стороны — иначе экран заполнялся
 * бы разницей, которой не существует.
 */
function compareRows(left: SideRead, right: SideRead, migratable: boolean): CompareEntry[] {
  if (!left.supported && !right.supported) return [];

  const keys = new Set<string>();
  for (const row of left.rows) keys.add(row.key);
  for (const row of right.rows) keys.add(row.key);

  const leftBy = new Map(left.rows.map((row) => [row.key, row]));
  const rightBy = new Map(right.rows.map((row) => [row.key, row]));

  return [...keys]
    .sort((a, b) => a.localeCompare(b))
    .map((key): CompareEntry => {
      const l = leftBy.get(key);
      const r = rightBy.get(key);
      const opaque = Boolean(l?.opaque || r?.opaque);

      let state: CompareState;
      if (l && r) {
        // Секреты сверяем только по наличию: сравнивать их значения означало бы
        // читать и держать их рядом, а показывать разницу — намекать на них.
        state = opaque || sameValue(l, r) ? 'same' : 'differs';
      } else if (l) {
        state = 'left-only';
      } else {
        state = 'right-only';
      }

      const blocked = l?.blocked ?? r?.blocked;
      return {
        key,
        left: l?.display,
        right: r?.display,
        state,
        opaque,
        blocked: migratable ? blocked : undefined,
      };
    });
}

function sameValue(a: Row, b: Row): boolean {
  return (a.compare ?? a.display) === (b.compare ?? b.display);
}
