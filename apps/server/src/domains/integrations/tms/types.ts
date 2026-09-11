import type {
  ProjectTestGroup,
  ProjectTestPointResult,
  ProjectTestRunRecord,
  TmsKind,
  TmsPushResult,
} from '@agentdeck/contracts';

/**
 * Тест-менеджмент — одним интерфейсом на три системы.
 *
 * Zephyr Scale, Xray и Test IT решают одну задачу и делают это по-разному: у
 * Zephyr свой REST поверх ключа проекта, у Xray — пара «клиент+секрет», JWT и
 * импорт результатов одним документом, у Test IT — своя установка, заголовок
 * `PrivateToken` и ран, собранный из выбранных кейсов. Наружу это не протекает:
 * панель забирает кейсы и отправляет прогон, а какая система на том конце —
 * вопрос настройки.
 *
 * Место истины по кейсам остаётся ТАМ, а не в панели: сюда они приезжают копией
 * с пометкой, откуда взялись (`tms:<ключ>` в тегах), и по этой же пометке
 * повторный забор не плодит дубликаты, а отправка знает, какому кейсу внешней
 * системы принадлежит результат.
 */

/** Кейс, как его отдала внешняя система. */
export interface TmsCase {
  /** Ключ в системе-источнике: `PROJ-T12` у Zephyr, `PROJ-42` у Xray. */
  key: string;
  title: string;
  precondition?: string;
  steps: { action: string; expected?: string; data?: string }[];
  expected?: string;
  /** Адрес кейса в системе-источнике, если он выводится из настройки. */
  url?: string;
}

/**
 * Кейсы одной выборки и признак того, что выборка неполна.
 *
 * Потолок здесь есть у всех трёх систем, и раньше он срабатывал молча: проект
 * на тысячу кейсов приезжал первой сотней, а ответ выглядел как «всё привезли».
 */
export interface TmsCaseBatch {
  cases: TmsCase[];
  /** Упёрлись в потолок панели: за ним остались ещё кейсы. */
  truncated?: boolean;
}

/** Прогон и способ узнать внешний ключ по результату. */
export interface TmsRunPush {
  run: ProjectTestRunRecord;
  keyOf: (result: ProjectTestPointResult) => string | undefined;
  /**
   * Ран/цикл, который этот же прогон уже завёл на той стороне. Задан —
   * результаты кладутся в него, а не в новый: отправляют по кнопке и иногда
   * дважды, и двойник в чужой системе заметят не скоро.
   */
  externalRunId?: string;
  /**
   * Ран на той стороне ЗАВЕДЁН — до того, как в него разложены результаты.
   *
   * Между этими двумя шагами у Zephyr и Test IT лежит по запросу на каждый
   * результат, и отказ на любом из них раньше уносил с собой сам факт создания:
   * след в записи прогона писался только по удачному концу, а следующая
   * отправка, не найдя следа, заводила В ЧУЖОЙ СИСТЕМЕ ВТОРОЙ РАН. Поэтому
   * ключ сообщается сразу, а `sync.ts` ставит по нему предварительную отметку.
   */
  onRunCreated?: (runId: string, url?: string) => void;
}

export interface TmsClient {
  /** Какая это система — им помечается след отправки в записи прогона. */
  kind: TmsKind;
  /** Как система называется человеку: «Zephyr Scale», «Xray», «Test IT». */
  title: string;
  /**
   * Проверка связи одним дешёвым запросом. Возвращает строку «кем вошли» для
   * карточки; забирать ради проверки все кейсы проекта незачем — это сотни
   * запросов чужой квоты за ответ «да, ключ рабочий».
   */
  ping(): Promise<string>;
  pullCases(): Promise<TmsCaseBatch>;
  pushRun(push: TmsRunPush): Promise<TmsPushResult>;
}

const TAG_PREFIX = 'tms:';

/** Тег, которым помечается привезённый кейс: по нему считается «уже есть». */
export function sourceTag(key: string): string {
  return `${TAG_PREFIX}${key}`;
}

/** Внешний ключ из тегов кейса; чужие теги не мешают. */
export function keyFromTags(tags: string[] | undefined): string | undefined {
  const tag = (tags ?? []).find((item) => item.startsWith(TAG_PREFIX));
  return tag ? tag.slice(TAG_PREFIX.length) : undefined;
}

/**
 * Карта «группа:кейс → внешний ключ» по файлам кейсов. Строится один раз на
 * отправку: результат прогона знает только свою пару идентификаторов, а тег
 * лежит на кейсе.
 */
export function externalKeys(groups: ProjectTestGroup[]): Map<string, string> {
  const keys = new Map<string, string>();
  for (const group of groups) {
    for (const testCase of group.cases) {
      const key = keyFromTags(testCase.tags);
      if (key) keys.set(`${group.id}:${testCase.id}`, key);
    }
  }
  return keys;
}

/** Готовый `keyOf` поверх такой карты. */
export function keyLookup(keys: Map<string, string>): TmsRunPush['keyOf'] {
  return (result) => keys.get(`${result.groupId}:${result.caseId}`);
}
