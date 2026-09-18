import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ProjectTestBaseline } from '@agentdeck/contracts';
import { writeBinaryFile } from '../../lib/safe-io.ts';
import {
  MAX_FILE_BYTES,
  ProjectTestsError,
  ProjectTestsNotFoundError,
  optional,
  readJson,
  testsFile,
  testsPath,
  writeJson,
} from './files.ts';
import { PngFormatError, decodePng, encodePng, type PngImage } from './png.ts';
import { readGroups } from './store.ts';
import { coded } from '../../lib/server-text.ts';
import { serverText } from '../../lib/server-texts.ts';

/**
 * Эталонные скриншоты: сравнение «было/стало» с картинкой-разницей.
 *
 * Прогон и раньше умел прикладывать скриншоты, но сравнивал их человек глазами —
 * то есть не сравнивал никто. Здесь эталон лежит в самом проекте
 * (`.agent/tests/baselines/<кейс>/<поинт>.png`), едет с ним в git и виден в
 * ревью: смена эталона — это осознанная правка в коммите, а не запись в чужой
 * базе.
 *
 * Решение принимает ДОЛЯ различающихся пикселей, а не факт различия: тень,
 * сглаживание шрифта и мигающий курсор дают несколько пикселей на любом честном
 * снимке, и «побайтно равно» означало бы красный прогон каждый раз.
 *
 * Чего здесь нет и не будет: молчаливого обновления эталона. Не сошлось —
 * рядом ложится снимок и разница, а эталон меняет ЧЕЛОВЕК кнопкой «Принять».
 * Эталон нечитаемый или другого размера — это НАЗВАННЫЙ провал: сравнение не
 * состоялось, и выдать его за совпадение нельзя.
 */

/** Папка эталонов внутри `.agent/tests`. */
const DIR = 'baselines';

/** Сколько пикселей могут разойтись, чтобы снимок всё ещё считался тем же. */
export const DEFAULT_MAX_DIFF_RATIO = 0.005;

/**
 * На сколько может отличаться канал, чтобы пиксель считался тем же. Сглаживание
 * шрифтов и пересжатие дают единицы; 24 из 255 — это заметный глазу сдвиг цвета,
 * но не «другая картинка».
 */
const CHANNEL_TOLERANCE = 24;

/** Цвет отличий на картинке-разнице: пурпурного в интерфейсах не бывает. */
const DIFF_COLOR: [number, number, number] = [255, 0, 255];

/** Насколько виден фон под отличиями — контекст нужен, но спорить с ним нельзя. */
const BACKGROUND_FADE = 0.12;

/** Имя файла из идентификатора поинта: в нём есть `|`, а это не имя файла. */
export function baselineSlug(pointId: string): string {
  const cleaned = pointId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned)
    throw coded(new ProjectTestsError('Не указан тест-поинт снимка.'), 'baseline-point-missing');
  return cleaned.slice(0, 120);
}

/** Идентификатор кейса как имя папки. */
function caseSlug(caseId: string): string {
  const cleaned = caseId.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!cleaned)
    throw coded(
      new ProjectTestsError('Не указан кейс, к которому относится снимок.'),
      'baseline-case-missing',
    );
  return cleaned;
}

/** Пути тройки «эталон / снимок / разница» одного поинта. */
function filesOf(caseId: string, pointId: string) {
  const relative = `${DIR}/${caseSlug(caseId)}/${baselineSlug(pointId)}`;
  return {
    baseline: `${relative}.png`,
    actual: `${relative}.actual.png`,
    diff: `${relative}.diff.png`,
    meta: `${relative}.json`,
  };
}

/** Итог последнего сравнения на диске — чтобы список не гадал по файлам. */
interface BaselineMeta {
  version: 1;
  status: ProjectTestBaseline['status'];
  diffRatio?: number;
  maxDiffRatio?: number;
  width?: number;
  height?: number;
  updatedAt?: string;
  message?: string;
  messageCode?: string;
  params?: Record<string, string | number>;
}

function readMeta(root: string, relative: string): BaselineMeta | undefined {
  const { data } = readJson(root, relative);
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  const status = optional(record.status);
  return {
    version: 1,
    status: (status as ProjectTestBaseline['status']) ?? 'match',
    diffRatio: typeof record.diffRatio === 'number' ? record.diffRatio : undefined,
    maxDiffRatio: typeof record.maxDiffRatio === 'number' ? record.maxDiffRatio : undefined,
    width: typeof record.width === 'number' ? record.width : undefined,
    height: typeof record.height === 'number' ? record.height : undefined,
    updatedAt: optional(record.updatedAt),
    message: optional(record.message),
    messageCode: optional(record.messageCode),
    params:
      record.params && typeof record.params === 'object'
        ? (record.params as Record<string, string | number>)
        : undefined,
  };
}

/** Прочитать PNG из проекта. Отсутствие файла — не ошибка, а «эталона нет». */
function readPng(root: string, relative: string): Buffer | undefined {
  const path = testsPath(root, relative);
  if (!existsSync(path)) return undefined;
  const buffer = readFileSync(path);
  if (buffer.byteLength > MAX_FILE_BYTES * 4) {
    throw coded(
      new ProjectTestsError(`Файл ${testsFile(relative)} слишком велик для сравнения.`),
      'baseline-file-too-large',
      { file: testsFile(relative) },
    );
  }
  return buffer;
}

function writePng(root: string, relative: string, body: Buffer): void {
  const path = testsPath(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeBinaryFile(path, body);
}

function removeFile(root: string, relative: string): void {
  rmSync(testsPath(root, relative), { force: true });
}

/**
 * Порог кейса. Своё значение важнее общего: анимированный экран честно шумит
 * на процент площади, а форма входа не должна расходиться ни на пиксель.
 */
function caseThreshold(root: string, caseId: string): number | undefined {
  for (const group of readGroups(root)) {
    if (group.error) continue;
    const found = group.cases.find((item) => item.id === caseId);
    if (found?.maxDiffRatio !== undefined) return found.maxDiffRatio;
  }
  return undefined;
}

/** Доля различающихся пикселей и картинка-разница поверх эталона. */
export function comparePixels(
  baseline: PngImage,
  actual: PngImage,
): { ratio: number; diffPixels: number; diff: PngImage } {
  const { width, height } = baseline;
  const total = width * height;
  const data = new Uint8Array(total * 4);
  let diffPixels = 0;

  for (let index = 0; index < total; index += 1) {
    const at = index * 4;
    // Прозрачность сводим к белому: снимок с альфой и снимок без неё — это
    // одна и та же картинка на экране, и различать их незачем.
    const mix = (source: Uint8Array, channel: number): number => {
      const alpha = source[at + 3]! / 255;
      return Math.round(source[at + channel]! * alpha + 255 * (1 - alpha));
    };
    const red = mix(baseline.data, 0);
    const green = mix(baseline.data, 1);
    const blue = mix(baseline.data, 2);
    const delta = Math.max(
      Math.abs(red - mix(actual.data, 0)),
      Math.abs(green - mix(actual.data, 1)),
      Math.abs(blue - mix(actual.data, 2)),
    );

    if (delta > CHANNEL_TOLERANCE) {
      diffPixels += 1;
      data[at] = DIFF_COLOR[0];
      data[at + 1] = DIFF_COLOR[1];
      data[at + 2] = DIFF_COLOR[2];
    } else {
      // Фон почти выбелен: разница должна читаться с расстояния вытянутой руки.
      data[at] = Math.round(255 - (255 - red) * BACKGROUND_FADE);
      data[at + 1] = Math.round(255 - (255 - green) * BACKGROUND_FADE);
      data[at + 2] = Math.round(255 - (255 - blue) * BACKGROUND_FADE);
    }
    data[at + 3] = 255;
  }

  return { ratio: total === 0 ? 0 : diffPixels / total, diffPixels, diff: { width, height, data } };
}

/** Что пришло на сравнение. */
export interface BaselineInput {
  caseId: string;
  pointId: string;
  /** Сам снимок: PNG как есть. */
  png: Buffer;
  /** Порог этого сравнения; пусто — порог кейса, затем общий. */
  maxDiffRatio?: number;
  now: string;
}

function decodeOrFail(png: Buffer, what: string): PngImage {
  try {
    return decodePng(png);
  } catch (error) {
    if (error instanceof PngFormatError)
      throw coded(
        new ProjectTestsError(`${what}: ${error.message}`),
        'baseline-snapshot-unparsed',
        {
          reason: error.message,
        },
      );
    throw error;
  }
}

function persist(
  root: string,
  caseId: string,
  pointId: string,
  meta: BaselineMeta,
): ProjectTestBaseline {
  const paths = filesOf(caseId, pointId);
  writeJson(root, paths.meta, meta);
  return {
    caseId,
    pointId,
    file: testsFile(paths.baseline),
    actualFile: existsSync(testsPath(root, paths.actual)) ? testsFile(paths.actual) : undefined,
    diffFile: existsSync(testsPath(root, paths.diff)) ? testsFile(paths.diff) : undefined,
    status: meta.status,
    diffRatio: meta.diffRatio,
    maxDiffRatio: meta.maxDiffRatio,
    width: meta.width,
    height: meta.height,
    updatedAt: meta.updatedAt,
    message: meta.message,
    messageCode: meta.messageCode,
    params: meta.params,
  };
}

/**
 * Сравнить снимок с эталоном.
 *
 * Эталона ещё нет — снимок им и становится (`new`): первый прогон не может
 * ничего провалить, ему не с чем сравнивать. Дальше решает только доля
 * различий; всё, что мешает сравнить (битый эталон, другой размер), — статус
 * `error` с причиной, и эталон при этом НЕ трогается.
 */
export function compareBaseline(root: string, input: BaselineInput): ProjectTestBaseline {
  const paths = filesOf(input.caseId, input.pointId);
  const actual = decodeOrFail(input.png, serverText('tests-baseline-png-broken'));
  const limit = input.maxDiffRatio ?? caseThreshold(root, input.caseId) ?? DEFAULT_MAX_DIFF_RATIO;

  const stored = readPng(root, paths.baseline);
  if (!stored) {
    writePng(root, paths.baseline, input.png);
    removeFile(root, paths.actual);
    removeFile(root, paths.diff);
    return persist(root, input.caseId, input.pointId, {
      version: 1,
      status: 'new',
      maxDiffRatio: limit,
      width: actual.width,
      height: actual.height,
      updatedAt: input.now,
      message: 'Эталона не было — снимок принят как эталон.',
      messageCode: 'baseline-created',
    });
  }

  // Снимок кладём рядом ДО разбора эталона: если эталон битый, человеку всё
  // равно нужно увидеть, что пришло, — иначе от провала остаётся одна строка.
  writePng(root, paths.actual, input.png);

  let baseline: PngImage;
  try {
    baseline = decodePng(stored);
  } catch (error) {
    return persist(root, input.caseId, input.pointId, {
      version: 1,
      status: 'error',
      maxDiffRatio: limit,
      updatedAt: input.now,
      message: `Эталон не читается: ${(error as Error).message} Прими снимок эталоном или почини файл.`,
      messageCode: 'baseline-unreadable',
      params: { reason: (error as Error).message },
    });
  }

  if (baseline.width !== actual.width || baseline.height !== actual.height) {
    return persist(root, input.caseId, input.pointId, {
      version: 1,
      status: 'error',
      maxDiffRatio: limit,
      width: actual.width,
      height: actual.height,
      updatedAt: input.now,
      message:
        `Размер снимка ${actual.width}×${actual.height} не совпал с эталоном ` +
        `${baseline.width}×${baseline.height} — сравнивать нечего.`,
      messageCode: 'baseline-size-mismatch',
      params: {
        actual: `${actual.width}×${actual.height}`,
        baseline: `${baseline.width}×${baseline.height}`,
      },
    });
  }

  const { ratio, diff } = comparePixels(baseline, actual);
  if (ratio <= limit) {
    // Совпало — прошлый спор закрыт: снимок и разница больше ничего не значат.
    removeFile(root, paths.actual);
    removeFile(root, paths.diff);
    return persist(root, input.caseId, input.pointId, {
      version: 1,
      status: 'match',
      diffRatio: ratio,
      maxDiffRatio: limit,
      width: actual.width,
      height: actual.height,
      updatedAt: input.now,
    });
  }

  writePng(root, paths.diff, encodePng(diff));
  return persist(root, input.caseId, input.pointId, {
    version: 1,
    status: 'diff',
    diffRatio: ratio,
    maxDiffRatio: limit,
    width: actual.width,
    height: actual.height,
    updatedAt: input.now,
    message: `Разошлось ${(ratio * 100).toFixed(2)}% пикселей при пороге ${(limit * 100).toFixed(2)}%.`,
    messageCode: 'baseline-diff-ratio',
    params: { ratio: (ratio * 100).toFixed(2), limit: (limit * 100).toFixed(2) },
  });
}

/** Принять последний снимок эталоном — единственный способ его сменить. */
export function acceptBaseline(
  root: string,
  caseId: string,
  pointId: string,
  now: string,
): ProjectTestBaseline {
  const paths = filesOf(caseId, pointId);
  const actual = readPng(root, paths.actual);
  if (!actual) {
    throw coded(
      new ProjectTestsNotFoundError('Нечего принимать: нового снимка по этому поинту нет.'),
      'baseline-nothing-to-accept',
    );
  }
  const image = decodeOrFail(actual, serverText('tests-baseline-png-broken'));
  writePng(root, paths.baseline, actual);
  removeFile(root, paths.actual);
  removeFile(root, paths.diff);
  return persist(root, caseId, pointId, {
    version: 1,
    status: 'match',
    diffRatio: 0,
    width: image.width,
    height: image.height,
    updatedAt: now,
    message: 'Снимок принят эталоном.',
    messageCode: 'baseline-accepted',
  });
}

/** Эталоны проекта: все или одного кейса. */
export function readBaselines(root: string, caseId?: string): ProjectTestBaseline[] {
  const cases = caseId ? [caseSlug(caseId)] : listEntries(root, DIR, 'dir');
  const result: ProjectTestBaseline[] = [];
  for (const owner of cases) {
    for (const name of listEntries(root, `${DIR}/${owner}`, 'file')) {
      // `.actual` и `.diff` — спутники эталона, а не отдельные снимки.
      if (!name.endsWith('.png') || name.endsWith('.actual.png') || name.endsWith('.diff.png')) {
        continue;
      }
      const slug = name.slice(0, -'.png'.length);
      const paths = filesOf(owner, slug);
      const meta = readMeta(root, paths.meta);
      result.push({
        caseId: owner,
        pointId: slug,
        file: testsFile(paths.baseline),
        actualFile: existsSync(testsPath(root, paths.actual)) ? testsFile(paths.actual) : undefined,
        diffFile: existsSync(testsPath(root, paths.diff)) ? testsFile(paths.diff) : undefined,
        status: meta?.status ?? (existsSync(testsPath(root, paths.diff)) ? 'diff' : 'match'),
        diffRatio: meta?.diffRatio,
        maxDiffRatio: meta?.maxDiffRatio,
        width: meta?.width,
        height: meta?.height,
        updatedAt: meta?.updatedAt,
        message: meta?.message,
        messageCode: meta?.messageCode,
        params: meta?.params,
      });
    }
  }
  return result;
}

/**
 * Содержимое папки эталонов. Своё, а не `listFiles`: там имена сужены до
 * идентификатора группы, а имя поинта — это кейс, окружение и параметры.
 */
function listEntries(root: string, relative: string, kind: 'dir' | 'file'): string[] {
  const path = testsPath(root, relative);
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => (kind === 'dir' ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}
