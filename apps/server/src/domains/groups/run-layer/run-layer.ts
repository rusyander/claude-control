import type { Group } from '@agentdeck/contracts';
import type { GroupLayerKind } from '@agentdeck/contracts/group-delivery';
import { serverText } from '../../../lib/server-texts/server-texts.ts';
import type { MemberDeps } from '../members/members.ts';
import { codexGroupLayerWriter } from '../codex-layer/codex-layer.ts';
import { qwenGroupLayerWriter } from '../qwen-run-layer/qwen-run-layer.ts';
import { layerDigest } from '../run-layer-parts.ts';
import type { GroupLayerPlan, GroupLayerWriter } from './run-layer.types.ts';

export type * from './run-layer.types.ts';
export {
  GroupLayerBlocked,
  groupLeaves,
  layerDigest,
  mergeGroupEnv,
  type GroupLeaf,
} from '../run-layer-parts.ts';

/**
 * Группа на ОДИН прогон чужого CLI — общий вход для всех слоёв.
 *
 * Чужой CLI файлов Claude не читает, и тумблер каталогов Claude ему ничего не
 * давал, а `~/.claude` человека при этом менялся. Поэтому группа едет слоем:
 * у каждого CLI свой механизм «на один запуск» (`ConfigProvider.groupLayer`), а
 * у CLI без слоя она не действует вовсе — и панель это говорит.
 *
 * Писатели импортируют общие части из `run-layer-parts.ts`, а не отсюда:
 * реестр ниже ссылается на них, и круговой импорт через этот модуль обратился
 * бы к писателю до его объявления.
 */

// Реестр по механизму: новый слой — одна строка.
// Методы интерфейса двувариантны: писатель со своей нагрузкой встаёт под `unknown`.
const WRITERS: Partial<Record<GroupLayerKind, GroupLayerWriter>> = {
  'qwen-system-settings': qwenGroupLayerWriter,
  'codex-overlay': codexGroupLayerWriter,
};

/** Писатель слоя по механизму каталога; не зарегистрирован — слоя нет. */
export function groupLayerWriter(kind: GroupLayerKind | undefined): GroupLayerWriter | undefined {
  return kind ? WRITERS[kind] : undefined;
}

/** Что группа делает для прогона этого CLI. */
export type RunLayerDecision =
  | { model: 'none'; providerId: string; cliName: string; groups: readonly Group[]; digest: string }
  | {
      model: 'run-layer';
      providerId: string;
      cliName: string;
      groups: readonly Group[];
      writer: GroupLayerWriter;
      plan: GroupLayerPlan;
      digest: string;
    };

/**
 * Решение для прогона: есть писатель слоя — его чистый план, нет — «не
 * действует». Тумблера каталогов Claude здесь нет ни в одной ветке.
 */
export function decideRunLayer(
  deps: MemberDeps,
  provider: { id: string; name: string; groupLayer?: GroupLayerKind },
  groups: readonly Group[],
  options: { env?: NodeJS.ProcessEnv } = {},
): RunLayerDecision {
  const base = { providerId: provider.id, cliName: provider.name, groups };
  const writer = groupLayerWriter(provider.groupLayer);
  if (!writer) {
    return {
      ...base,
      model: 'none',
      digest: layerDigest(['none', provider.id, groups.map((group) => group.id)]),
    };
  }
  const plan = writer.plan(
    deps,
    { providerId: provider.id, cliName: provider.name, groups },
    options,
  );
  return { ...base, model: 'run-layer', writer, plan, digest: plan.digest };
}

const KIND_ORDER = ['rule', 'skill', 'mcp', 'hook', 'env'] as const;
type NoticeKind = (typeof KIND_ORDER)[number];

function isNoticeKind(kind: string): kind is NoticeKind {
  return (KIND_ORDER as readonly string[]).includes(kind);
}

/**
 * Заметка в ленту чужого чата: какие группы на прогоне, что доехало слоем и
 * что нет — с причиной. Русским текстом сервера (лента хранит строку), из
 * шаблонов: тот же текст переводит панель по коду.
 */
export function runLayerNotice(decision: RunLayerDecision): string {
  const names = decision.groups.map((group) => `«${group.name}»`).join(', ');
  const lines = [serverText('group-layer-notice', { cli: decision.cliName, groups: names })];
  if (decision.model === 'none') {
    lines.push(serverText('group-layer-none', { cli: decision.cliName }));
    return lines.join('\n');
  }
  const byKind = new Map<NoticeKind, Set<string>>();
  for (const { member } of decision.plan.delivered) {
    const at = member.indexOf(':');
    const kind = member.slice(0, at);
    if (!isNoticeKind(kind)) continue;
    const list = byKind.get(kind) ?? new Set<string>();
    list.add(member.slice(at + 1));
    byKind.set(kind, list);
  }
  const parts = KIND_ORDER.flatMap((kind) => {
    const list = byKind.get(kind);
    return list?.size
      ? [serverText(`group-layer-kind-${kind}`, { names: [...list].join(', ') })]
      : [];
  });
  lines.push(
    parts.length
      ? serverText('group-layer-notice-delivered', { members: parts.join('; ') })
      : serverText('group-layer-notice-nothing'),
  );
  const reasons = [
    ...new Set(decision.plan.refused.map((refusal) => serverText(refusal.code, refusal.params))),
  ];
  if (reasons.length) {
    lines.push(serverText('group-layer-notice-refused'));
    for (const reason of reasons) lines.push(`— ${reason}`);
  }
  return lines.join('\n');
}
