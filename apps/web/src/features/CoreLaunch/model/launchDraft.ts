import { estimateFieldsSchema, type EstimateFields } from '@agentdeck/contracts/core/estimate';
import { PRESET_IDS, type PresetId } from '@agentdeck/contracts/core/scenario';
import { newUuidv7 } from '@entities/CoreTask';
import type {
  DraftField,
  DraftProblem,
  EstimateAttempt,
  LaunchDraft,
  ScenarioChoice,
  ScenarioListing,
  ScenarioOption,
} from './launch.types';

/**
 * Модель формы запуска: черновик → поля оценки (та же схема, что разбирает ядро) → ключ повтора.
 * Оценка = создание задачи (G5), поэтому ключ повтора держится, пока ответа нет: потерянный ответ
 * и повторное нажатие с тем же черновиком дают ту же задачу (`200 replayed`), а не вторую.
 */

export const DEFAULT_PRESET: PresetId = 'feature';

/**
 * Пресет ответов ревьюерам ядро открывает только из опроса форжа (по MR законченной задачи) —
 * человек получил бы 422 на любой оценке, поэтому вариант виден, но выбрать его нельзя.
 */
export const FORGE_ONLY_PRESET: PresetId = 'answer-reviewers';

/**
 * Политика после принятого деления: всегда `confirm`. Экран запуска и есть точка подтверждения —
 * при `auto` ядро запустило бы деление само, мимо подтверждения грантов на этом экране.
 */
export const LAUNCH_POLICY = 'confirm' as const;

export const REPOS_MAX = 8;

export function emptyDraft(): LaunchDraft {
  return {
    title: '',
    request: '',
    repos: [{ path: '', baseRef: '' }],
    scenario: { kind: 'preset', id: DEFAULT_PRESET },
    // CI не ждём, пока человек не попросил сам (07:25, R:S1-09).
    ciWait: false,
  };
}

function scenarioField(choice: ScenarioChoice): EstimateFields['scenario'] {
  return choice.kind === 'preset'
    ? { preset: choice.id }
    : { id: choice.id, version: choice.version };
}

const FIELD_OF_PATH: Record<string, DraftField> = {
  title: 'title',
  request: 'request',
  repos: 'repos',
  scenario: 'scenario',
};

/**
 * Поля тела `POST /v1/estimate` из черновика. Пустые строки репозиториев отброшены, пустая база —
 * `null` (ядро берёт ветку по умолчанию); проверка — схемой контрактов, той же, что у ядра, чтобы
 * форма не отправляла то, что ядро вернёт 400.
 */
export function fieldsOf(
  draft: LaunchDraft,
): { ok: true; fields: EstimateFields } | { ok: false; problems: DraftProblem[] } {
  const candidate = {
    title: draft.title.trim(),
    request: draft.request.trim(),
    repos: draft.repos
      .map((r) => ({ path: r.path.trim(), baseRef: r.baseRef.trim() || null }))
      .filter((r) => r.path.length > 0),
    scenario: scenarioField(draft.scenario),
    launchPolicy: LAUNCH_POLICY,
    ciWait: draft.ciWait,
  };
  const problems: DraftProblem[] = [];
  if (draft.scenario.kind === 'preset' && draft.scenario.id === FORGE_ONLY_PRESET)
    problems.push({ field: 'scenario', message: 'forge-only' });
  const parsed = estimateFieldsSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = FIELD_OF_PATH[String(issue.path[0])] ?? 'request';
      if (!problems.some((p) => p.field === field))
        problems.push({ field, message: issue.message });
    }
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, fields: candidate as EstimateFields };
}

/** Отпечаток полей: порядок ключей задан сборкой `fieldsOf`, поэтому JSON сравним как есть. */
export function fieldsKey(fields: EstimateFields): string {
  return JSON.stringify(fields);
}

/**
 * Ключ повтора для этих полей: прежний, если черновик тот же и ответа ещё не было, иначе новый.
 * Ответ пришёл — вызывающий сбрасывает попытку (`null`): следующая оценка — новая задача.
 */
export function attemptFor(
  prev: EstimateAttempt | null,
  fields: EstimateFields,
  mint: () => string = newUuidv7,
): EstimateAttempt {
  const key = fieldsKey(fields);
  if (prev && prev.key === key) return prev;
  return { cmdId: mint(), key };
}

const PRESET_SET = new Set<string>(PRESET_IDS);

export function scenarioValue(choice: ScenarioChoice): string {
  return choice.kind === 'preset'
    ? `preset:${choice.id}`
    : `library:${choice.id}@${choice.version}`;
}

export function choiceOfValue(value: string): ScenarioChoice | null {
  const preset = /^preset:(.+)$/.exec(value);
  if (preset) {
    const id = preset[1] as string;
    return PRESET_SET.has(id) ? { kind: 'preset', id: id as PresetId } : null;
  }
  const lib = /^library:(.+)@(\d+)$/.exec(value);
  if (lib) return { kind: 'library', id: lib[1] as string, version: Number(lib[2]) };
  return null;
}

/**
 * Варианты выбора сценария: пресеты ядра (по одной строке на id — последняя версия, её ядро и
 * возьмёт) и каждая версия библиотеки. Пресет форжа виден выключенным: скрытый вариант выглядел
 * бы забытым.
 */
export function scenarioOptions(listing: ScenarioListing | undefined): ScenarioOption[] {
  const presets = new Map<string, string>();
  for (const p of listing?.presets ?? []) if (!presets.has(p.id)) presets.set(p.id, p.title);
  for (const id of PRESET_IDS) if (!presets.has(id)) presets.set(id, id);
  const out: ScenarioOption[] = [...presets].map(([id, title]) => ({
    value: `preset:${id}`,
    label: title,
    disabled: id === FORGE_ONLY_PRESET,
  }));
  for (const s of listing?.library ?? []) {
    out.push({
      value: `library:${s.id}@${s.version}`,
      label: `${s.title} · v${s.version}`,
      disabled: false,
    });
  }
  return out;
}
