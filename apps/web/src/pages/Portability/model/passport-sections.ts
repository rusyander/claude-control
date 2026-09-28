import type {
  AgentEnvironment,
  EnvItem,
  EnvItemKind,
  EnvSectionState,
  EnvSkip,
} from '@agentdeck/contracts/portable-env';
import { KIND_ORDER } from '@entities/Portability';

/** Секция паспорта: записи и пропуски одного вида плюс рубильник раздела. */
export interface PassportSectionView {
  kind: EnvItemKind;
  items: EnvItem[];
  skipped: EnvSkip[];
  state: EnvSectionState | undefined;
}

/** Записи по видам в порядке `KIND_ORDER`; вид без записей и пропусков секции не рисует. */
export function passportSections(env: AgentEnvironment | undefined): PassportSectionView[] {
  const items = env?.items ?? [];
  const skipped = env?.skipped ?? [];

  const byKind = new Map<EnvItemKind, EnvItem[]>();
  for (const item of items) {
    const list = byKind.get(item.kind);
    if (list) list.push(item);
    else byKind.set(item.kind, [item]);
  }

  const skipsByKind = new Map<EnvItemKind, EnvSkip[]>();
  for (const skip of skipped) {
    const list = skipsByKind.get(skip.kind);
    if (list) list.push(skip);
    else skipsByKind.set(skip.kind, [skip]);
  }

  // Вид, которого нет в порядке показа, всё равно попадает на экран — хвостом
  // за известными. Потерять его значило бы показать среду без него.
  const known = new Set<EnvItemKind>(KIND_ORDER);
  const tail = [...byKind.keys(), ...skipsByKind.keys()].filter((kind) => !known.has(kind));

  // Рубильник раздела: состояние источника, а не запись. Ищется по виду —
  // список короткий и почти всегда пуст.
  const states = env?.sectionStates ?? [];

  return [...KIND_ORDER, ...new Set(tail)]
    .map((kind) => ({
      kind,
      items: byKind.get(kind) ?? [],
      skipped: skipsByKind.get(kind) ?? [],
      state: states.find((candidate) => candidate.kind === kind),
    }))
    .filter((section) => section.items.length > 0 || section.skipped.length > 0);
}
