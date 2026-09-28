import { array, object, string, type infer as Infer } from 'zod';
import {
  pathPromoteRequestSchema,
  type PathResourceType,
  type PathStepProposal,
} from './group-path.ts';

/**
 * Описания участников группы и готовых ресурсов на языке интерфейса: имя и
 * одна строка «что делает» на русском и английском. Пишет их дешёвая модель по
 * тексту самого ресурса (у хука — событие, фильтр, команда и текст скрипта, на
 * который команда ссылается), один вызов на ресурс сразу на двух языках; кэш —
 * по хэшу отправленного текста. Ответы никогда не ждут модели: готовое — из
 * кэша, остальное названо в `pending` и описывается в фоне.
 */

export interface LocalizedLine {
  ru: string;
  en: string;
}

const lineSchema = object({
  ru: string().trim().min(1).max(400),
  en: string().trim().min(1).max(400),
});

export type DescribedKind = 'skill' | 'hook' | 'rule' | 'mcp' | 'permission' | 'group';

/** Один участник группы, читаемый на языке интерфейса. */
export interface MemberDescription {
  kind: DescribedKind;
  /** В интерфейсе второстепенен: у хука это `Event:hash`. */
  id: string;
  /** Человеческое имя: «перед правкой файла: проверка документации». Нет — ещё не описан. */
  title?: LocalizedLine;
  /** Одна строка «что делает». */
  summary?: LocalizedLine;
  /** Строка из файла самого участника (описание в шапке, команда хука) — без модели. */
  description?: string;
  /** Файла участника нет. */
  missing?: true;
  /**
   * Общего файла нет, но он лежит в `.claude` привязанного проекта (путь
   * проекта): группа им не управляет, а «файла нет» соврало бы (28.09, живая группа владельца).
   */
  foundIn?: string;
}

/** Нумерованный шаг скилла-участника («## 3. …»); `index` с нуля — как у шага скилла в пути. */
export interface SkillStepDescription {
  skillId: string;
  index: number;
  title: LocalizedLine;
  summary: LocalizedLine;
}

/** `GET /api/groups/:id/members`. */
export interface GroupMembersView {
  groupId: string;
  members: MemberDescription[];
  /** Только уже описанные шаги. */
  steps: SkillStepDescription[];
  /** Ещё описываются: `kind:id` участника, `step:<skillId>` — шаги скилла. */
  pending?: string[];
}

export type CatalogItemType = 'skill' | 'rule' | 'hook' | 'script';

/** Строка выбора «Выбрать готовый». */
export interface ResourceCatalogItem {
  type: CatalogItemType;
  /** id скилла, правила или хука; у скрипта — имя файла относительно каталога скриптов. */
  id: string;
  scope: 'global' | 'project';
  title?: LocalizedLine;
  summary?: LocalizedLine;
  /** Строка из самого файла, когда она там есть. */
  description?: string;
}

/** `GET /api/groups/resource-catalog?path=`. */
export interface ResourceCatalogView {
  items: ResourceCatalogItem[];
  /** Ещё описываются: `type:id`. */
  pending?: string[];
}

/** Ответ модели на описание одного ресурса; `steps` — только у скилла с нумерованными шагами. */
export const describeAnswerSchema = object({
  title: lineSchema,
  summary: lineSchema,
  steps: array(object({ title: lineSchema, summary: lineSchema })).default([]),
});
export type DescribeAnswer = Infer<typeof describeAnswerSchema>;

/**
 * Ассистент шага: у совпавшего и похожих ресурсов — что они делают на обоих
 * языках (из кэша описаний, иначе со слов модели).
 */
export type DescribedResourceRef = { type: PathResourceType; id: string; why: string } & {
  summary?: LocalizedLine;
};
export type DescribedPathStepProposal = Omit<PathStepProposal, 'match' | 'similar'> & {
  match?: DescribedResourceRef;
  similar: DescribedResourceRef[];
};

/**
 * «Сделать глобальным» с именем файла: у скрипта `name` — имя файла
 * (`check-docs.mjs`); нет — из заголовка шага. У остальных видов не читается.
 */
export const pathPromoteNamedRequestSchema = pathPromoteRequestSchema.extend({
  name: string().trim().min(1).max(120).optional(),
});
export type PathPromoteNamedRequest = Infer<typeof pathPromoteNamedRequestSchema>;
