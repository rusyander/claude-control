import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OWNER_REQUEST_END,
  OWNER_REQUEST_OPENER,
  ownerCoverageLine,
} from '@agentdeck/contracts/quality-floor';
import type { SieveReportRow } from '@agentdeck/contracts/sieves';
import { RUN_DIR, ensureRunDir } from '../../../lib/run-dir/run-dir.ts';

/**
 * Слова владельца и сданные строки отчёта — файлом в копии (живая группа 26.10,
 * стадия правок): сразу после сжатия группе понадобились дословная просьба и
 * номера `owner-N`, а резюме их не сохранило. Источника, кроме своего транскрипта,
 * не было — 7 вызовов за 2,5 минуты: `grep` по jsonl на 3,3 МБ упёрся в таймаут,
 * `indexOf` вытащил 39 тыс. знаков в контекст. Файл читается одним Read, а путь к
 * нему стоит в правиле расхода — системная дописка сжатие переживает.
 *
 * Файл ведёт панель: переписывается на старте группы и на старте каждого звена,
 * агент его не правит (своё он пишет в тетрадь задачи).
 */
export const OWNER_BRIEF = `${RUN_DIR}/owner-request.agent.md`;

/** Доказательство строки в файле — коротко: номер и статус важнее пересказа. */
const EVIDENCE_MAX = 160;

const TITLE =
  "# Owner's request — kept by the panel\n\n" +
  'Rewritten by the panel at the group start and at every stage start; read it after a ' +
  'compaction instead of searching the transcript. Do not edit it.\n';

/**
 * Блок слов владельца из задания группы: от шапки до конца реплик и строка следа
 * требований (в ней формат блока `sieves` и номера `owner-N`). Строка — текущая, а
 * не та, что была в задании: у записи, начатой до её правки, строки нет вовсе.
 */
export function ownerBlockOf(task: string | undefined): string | undefined {
  const start = task?.indexOf(OWNER_REQUEST_OPENER) ?? -1;
  if (!task || start < 0) return undefined;
  const end = task.indexOf(OWNER_REQUEST_END, start);
  if (end < 0) return undefined;
  return `${task.slice(start, end + OWNER_REQUEST_END.length).trim()}\n\n${ownerCoverageLine()}`;
}

function rowLine(row: SieveReportRow): string {
  const evidence = row.evidence.replace(/\s+/g, ' ').trim();
  const short =
    evidence.length > EVIDENCE_MAX ? `${evidence.slice(0, EVIDENCE_MAX - 1)}…` : evidence;
  return `- ${row.id} ${row.status}${short ? ` — ${short}` : ''}`;
}

/** Разделы одной группы узнаются по хвосту заголовка — названию группы. */
const groupSuffix = (group: string): string => ` — ${group.replace(/\s+/g, ' ').trim()}`;

export interface OwnerBriefInput {
  /** Задание группы (`groupTask`/`task` связи): в нём блок слов владельца. */
  task: string | undefined;
  /** Название группы — заголовок её разделов. */
  group: string;
  /** Строки отчёта, сданные прошлыми звеньями (`ChatLink.sieveRows`). */
  rows?: readonly SieveReportRow[];
  /** Абзац сит звена, которое сейчас стартует (`sievePromptBlock`). */
  sieves?: string;
  /**
   * Старт группы: свои разделы прежнего файла остаются. Группу перезапускают и
   * поднимают, и строк звеньев у старта нет — пустой раздел стёр бы сданное.
   */
  keepOwn?: boolean;
}

/**
 * Записать файл. Блока слов владельца в задании нет — файла нет (возвращается
 * `undefined`): группе без слов владельца отчитываться по `owner-N` не о чем.
 *
 * В проекте без git группы делят один каталог: разделы других групп той же
 * просьбы остаются, а разделы прошлого разделения с другой просьбой — уходят
 * вместе с ней. Запись — целиком через временный файл: группа может читать его
 * в ту же секунду.
 */
export function writeOwnerBrief(cwd: string, input: OwnerBriefInput): string | undefined {
  const block = ownerBlockOf(input.task);
  if (!block) return undefined;
  const head = `${TITLE}\n${block}\n`;
  const suffix = groupSuffix(input.group);
  const file = join(cwd, OWNER_BRIEF);
  const others = existsSync(file)
    ? keptSections(readFileSync(file, 'utf8'), head, input.keepOwn ? undefined : suffix)
    : [];
  const own: string[] = [];
  if (input.rows?.length) {
    own.push(`## Rows already reported${suffix}\n\n${input.rows.map(rowLine).join('\n')}\n`);
  }
  if (input.sieves?.trim()) {
    own.push(`## Sieves of the current stage${suffix}\n\n${input.sieves.trim()}\n`);
  }
  ensureRunDir(cwd);
  const temp = `${file}.tmp`;
  writeFileSync(temp, [head, ...others, ...own].join('\n'));
  renameSync(temp, file);
  return OWNER_BRIEF;
}

/**
 * Разделы прежнего файла, которые остаются, — только если просьба та же: все
 * без `suffix`, иначе — кроме разделов группы с этим хвостом заголовка.
 */
function keptSections(text: string, head: string, suffix: string | undefined): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  if (!normalized.startsWith(head)) return [];
  return normalized
    .slice(head.length)
    .split(/\n(?=## )/)
    .map((section) => section.trim())
    .filter(
      (section) =>
        section.startsWith('## ') && !(suffix && (section.split('\n')[0] ?? '').endsWith(suffix)),
    )
    .map((section) => `${section}\n`);
}
