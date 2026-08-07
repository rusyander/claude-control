import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import type { ProjectFileContent } from '@claude-control/contracts';
import { diffLines } from '../history.ts';
import { MAX_DIFF_CHARS, MAX_FILE_BYTES, MAX_MEDIA_BYTES } from './constants.ts';
import { rebuildBaseline, type AgentEdit } from './edits.ts';
import { previewKindOf } from './media.ts';
import { resolveProjectPath } from './paths.ts';

/**
 * Чтение одного файла проекта вместе со всем, что нужно редактору: текущий
 * текст, восстановленный текст «до», счётчики правок и время записи на диске.
 *
 * Всё одним ответом намеренно: клиент открывает файл ОДНИМ запросом, и `mtimeMs`
 * приходит из того же чтения, что и содержимое. Разнеси это на два обращения —
 * между ними появится щель, в которую влезет запись агента, и проверка свежести
 * при сохранении начнёт сравнивать с чужим временем.
 */
export function readProjectFile(
  root: string,
  file: string,
  edits: AgentEdit[] = [],
): ProjectFileContent {
  const path = resolveProjectPath(root, file);
  const stats = statSync(path);
  if (!stats.isFile()) throw new Error('Это не файл.');

  const preview = previewKindOf(file);
  const base = {
    path: file,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    isReadOnly: !canWrite(path),
    preview,
  };

  // Картинка и PDF не проходят текстовый путь вовсе: их байты клиент забирает
  // отдельным запросом, поэтому и потолок у них свой, и «двоичный» здесь не
  // отказ, а признак того, ЧЕМ показывать.
  if (preview === 'image' || preview === 'pdf') {
    return {
      ...base,
      content: '',
      kind: 'none',
      added: 0,
      removed: 0,
      unmatched: 0,
      isBinary: true,
      tooBig: stats.size > MAX_MEDIA_BYTES,
    };
  }

  // Текста нет — значит, нечего и показывать разметкой: SVG и Markdown
  // рисуются ИЗ содержимого, и обещать превью без него было бы обещанием
  // пустого экрана.
  if (stats.size > MAX_FILE_BYTES) {
    return {
      ...base,
      preview: undefined,
      content: '',
      kind: 'none',
      added: 0,
      removed: 0,
      unmatched: 0,
      isBinary: false,
      tooBig: true,
    };
  }

  const buffer = readFileSync(path);
  if (looksBinary(buffer)) {
    return {
      ...base,
      preview: undefined,
      content: '',
      kind: 'none',
      added: 0,
      removed: 0,
      unmatched: 0,
      isBinary: true,
      tooBig: false,
    };
  }

  const content = buffer.toString('utf8');
  const baseline = rebuildBaseline(content, edits);
  const tooBig = content.length > MAX_DIFF_CHARS || (baseline.text?.length ?? 0) > MAX_DIFF_CHARS;

  if (baseline.text === undefined || tooBig) {
    return {
      ...base,
      content,
      kind: tooBig ? 'none' : baseline.kind,
      added: 0,
      removed: 0,
      unmatched: baseline.unmatched,
      isBinary: false,
      tooBig,
    };
  }

  const diff = diffLines(baseline.text, content);
  return {
    ...base,
    content,
    baseline: baseline.text,
    kind: baseline.kind,
    added: diff.added,
    removed: diff.removed,
    unmatched: baseline.unmatched,
    isBinary: false,
    tooBig: false,
  };
}

/**
 * Двоичный ли файл. Признак тот же, что у большинства инструментов: нулевой байт
 * в начале. Разбирать содержимое глубже незачем — решение здесь ровно одно,
 * показывать текст или отказаться.
 */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8000).includes(0);
}

/** Можно ли писать в файл по правам ОС: редактор не предлагает того, что не выйдет. */
function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
