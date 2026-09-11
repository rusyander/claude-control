import {
  isPromptId,
  promptOverridesSchema,
  type PromptId,
  type PromptOverride,
} from '@agentdeck/contracts/prompts';

/**
 * Промпты в архиве переноса: едут ТОЛЬКО правки человека.
 *
 * Встроенные тексты в архив не кладутся, и это не экономия места, а правило:
 * встроенный текст приезжает вместе с панелью, и привезённая с чужой машины
 * копия просто перекрыла бы его молча — на новой машине человек читал бы в
 * карточке «встроенный» текст прежней версии панели. Поэтому архив везёт разницу
 * («вот что я здесь переписал»), а не полный каталог.
 *
 * Из того же правила следует и обратное: разворот не может затереть встроенный
 * текст, потому что писать ему некуда — встроенный лежит в файлах репозитория,
 * а правка в каталоге данных.
 */

/** Файл секции внутри архива. Виден при обычной распаковке, читается глазами. */
export const PANEL_PROMPTS_PATH = 'panel/prompts.json';

/** Версия секции. Растёт при несовместимом изменении её раскладки. */
export const PANEL_PROMPTS_VERSION = 1;

export interface PanelPromptsDocument {
  version: number;
  overrides: PromptOverride[];
}

export function buildPanelPrompts(overrides: PromptOverride[]): PanelPromptsDocument {
  return { version: PANEL_PROMPTS_VERSION, overrides: overrides.map((item) => ({ ...item })) };
}

/** Байты секции для zip — одной функцией с описью, чтобы они не разъехались. */
export function panelPromptsFile(document: PanelPromptsDocument): Buffer {
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

/** Что известно про одну правку из архива ДО записи. */
export interface PromptImportPlanEntry {
  id: string;
  /** `new` — здесь этот промпт не правили; `same` — правка совпадает; `differs` — правка другая. */
  status: 'new' | 'same' | 'differs';
  bytes: number;
  /**
   * Промпта с таким идентификатором в этой панели нет (архив собран новее).
   * Такую строку разворот пропускает: писать правку промпта, которого не
   * существует, значило бы оставить на диске файл, который никто не прочитает.
   */
  unknown: boolean;
}

export interface PanelPromptsPlan {
  entries: PromptImportPlanEntry[];
  /** Секция есть, но разобрать её не вышло. Пусто — секции просто нет. */
  problem?: string;
}

export interface PanelPromptsInput {
  /** Содержимое `panel/prompts.json`, если оно в архиве есть. */
  data?: Buffer;
  /** Правки, уже сделанные на ЭТОЙ машине. */
  current: PromptOverride[];
}

/** План по секции промптов. Ничего не пишет: архив пришёл с чужой машины. */
export function planPanelPrompts(input: PanelPromptsInput): PanelPromptsPlan {
  const document = parsePanelPrompts(input.data);
  if (!document) return { entries: [] };
  if ('problem' in document) return { entries: [], problem: document.problem };

  const here = new Map(input.current.map((override) => [override.id, override]));

  return {
    entries: document.overrides.map((override) => {
      const mine = here.get(override.id);
      return {
        id: override.id,
        status: !mine ? 'new' : mine.text === override.text ? 'same' : 'differs',
        bytes: Buffer.byteLength(override.text, 'utf8'),
        unknown: !isPromptId(override.id),
      };
    }),
  };
}

/**
 * Отобранные человеком правки, готовые к записи. Неизвестные панели
 * идентификаторы отсеиваются здесь, а не в маршруте: это правило переноса, и
 * проверяется оно отдельно от записи.
 */
export function takePanelPrompts(
  data: Buffer | undefined,
  selection: string[],
): (PromptOverride & { id: PromptId })[] {
  const document = parsePanelPrompts(data);
  if (!document || 'problem' in document) return [];
  const wanted = new Set(selection);
  return document.overrides.filter(
    (override): override is PromptOverride & { id: PromptId } =>
      wanted.has(override.id) && isPromptId(override.id),
  );
}

function parsePanelPrompts(
  data: Buffer | undefined,
): PanelPromptsDocument | { problem: string } | undefined {
  if (!data) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(data.toString('utf8'));
  } catch {
    return { problem: 'Секция промптов повреждена: не разбирается как JSON.' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problem: 'Секция промптов должна быть объектом.' };
  }

  const record = raw as Record<string, unknown>;
  if (typeof record.version === 'number' && record.version > PANEL_PROMPTS_VERSION) {
    return {
      problem: `Секция промптов новее поддерживаемой версии (${record.version} > ${PANEL_PROMPTS_VERSION}).`,
    };
  }

  const overrides = promptOverridesSchema.safeParse(record.overrides ?? []);
  if (!overrides.success) return { problem: 'Секция промптов не проходит проверку.' };

  return { version: PANEL_PROMPTS_VERSION, overrides: overrides.data };
}
