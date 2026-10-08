import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Group, GroupMember, Hook } from '@agentdeck/contracts';
import type { GroupScope } from '@agentdeck/contracts/group-sources';
import { projectKey } from '../../lib/app-store/group-sources.ts';
import { readTextFile } from '../../lib/safe-io/safe-io.ts';
import { maskSecretsInText } from '../../lib/secret-mask/secret-mask.ts';
import { readHooks, readHooksFromFiles } from '../hooks/hooks.ts';
import { readScriptContent } from '../scripts/scripts.ts';
import type { DescribeSource } from './describe/describe.ts';
import { hashText, memberContent, projectClaudeDir, type MemberDeps } from './members/members.ts';
import { skillSteps, stepHeadings } from './path/path.ts';

/**
 * Текст, по которому модель описывает ресурс, — по одному на вид. Всё, что
 * уходит модели, проходит маску секретов; хэш кэша — от этого же текста, так
 * что правка скрипта хука (а не только его команды) даёт новое описание.
 */

const TEXT_LIMIT = 24_000;
const SCRIPT_LIMIT = 12_000;
const SCRIPT_MAX_BYTES = 512 * 1024;

function whereOf(scope: GroupScope): string {
  return scope.kind === 'project' ? projectKey(scope.path) : 'global';
}

const CUT_MARK = '\n[…]\n';

/**
 * Текст скилла с шагами в пределах лимита — так, что КАЖДЫЙ шаг доходит до
 * модели хотя бы началом. Обрезка по символам отрезала хвост целиком: у скилла
 * доставки шаги 13–14 лежали за лимитом, модель их не видела и называла 12 —
 * «описать шаг не вышло» навсегда. Каждый раздел (вступление и шаги) режется
 * до одной общей длины, подобранной так, чтобы сумма влезла.
 */
export function fitStepsText(raw: string, limit: number): string {
  if (raw.length <= limit) return raw;
  const heads = stepHeadings(raw);
  if (heads.length === 0) return raw.slice(0, limit);
  const lines = raw.split('\n');
  const cuts = [0, ...heads.map((head) => head.line), lines.length];
  const sections = cuts.slice(0, -1).map((from, i) => lines.slice(from, cuts[i + 1]).join('\n'));
  const budget = limit - sections.length * CUT_MARK.length;
  const total = (cap: number): number =>
    sections.reduce((sum, section) => sum + Math.min(section.length, cap), 0);
  let low = 0;
  let high = Math.max(...sections.map((section) => section.length));
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (total(mid) <= budget) low = mid;
    else high = mid - 1;
  }
  return sections
    .map((section) => (section.length > low ? `${section.slice(0, low)}${CUT_MARK}` : section))
    .join('\n');
}

function sourceOf(
  scope: GroupScope,
  kind: string,
  id: string,
  raw: string,
  steps: readonly string[] = [],
): DescribeSource {
  const text = maskSecretsInText(fitStepsText(raw, TEXT_LIMIT));
  return { key: `${whereOf(scope)}|${kind}:${id}`, kind, id, text, hash: hashText(text), steps };
}

/** Путь скрипта из команды хука → файл: `~`, `$HOME`, `%USERPROFILE%`, `$CLAUDE_PROJECT_DIR`, относительный. */
export function hookScriptFile(scriptPath: string, root: string | undefined): string {
  const home = homedir();
  const expanded = scriptPath
    .replace(/^~(?=[\\/])/, home)
    .replace(/\$\{?HOME\}?|%USERPROFILE%/gi, home)
    .replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, root ?? process.cwd());
  return isAbsolute(expanded) ? expanded : resolve(root ?? process.cwd(), expanded);
}

/** Файл внутри каталога — по реальным путям, чтобы ссылка не увела наружу. */
function isInside(file: string, dir: string): boolean {
  try {
    const rel = relative(realpathSync(dir), realpathSync(file));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

function scriptText(file: string): string | undefined {
  try {
    if (!existsSync(file) || statSync(file).size > SCRIPT_MAX_BYTES) return undefined;
    return readTextFile(file).slice(0, SCRIPT_LIMIT);
  } catch {
    return undefined;
  }
}

function hooksOf(deps: MemberDeps, scope: GroupScope): { hooks: Hook[]; root?: string } {
  if (scope.kind !== 'project') return { hooks: readHooks(deps.paths.settings, deps.store) };
  const dir = projectClaudeDir(scope.path);
  return {
    hooks: readHooksFromFiles(
      join(dir, 'settings.json'),
      join(dir, 'settings.local.json'),
      scope.path,
    ),
    root: scope.path,
  };
}

/** Хук: событие, фильтр, команда и текст скрипта, который команда запускает. */
export function hookSource(
  deps: MemberDeps,
  scope: GroupScope,
  id: string,
): DescribeSource | undefined {
  const { hooks, root } = hooksOf(deps, scope);
  const hook = hooks.find((item) => item.id === id);
  if (!hook) return undefined;
  // Ревью 28.09 (F-20): команда хука может назвать любой файл на диске, а его
  // текст уходит модели описания и оседает в describe.json. Читаем скрипт,
  // только если он лежит внутри проекта (у общего хука — внутри каталога конфига).
  const file = hook.scriptPath ? hookScriptFile(hook.scriptPath, root) : undefined;
  const script = file && isInside(file, root ?? deps.paths.root) ? scriptText(file) : undefined;
  const lines = [
    `event: ${hook.event}`,
    ...(hook.matcher ? [`matcher: ${hook.matcher}`] : []),
    `command: ${hook.command}`,
    ...(script !== undefined ? ['', `script ${hook.scriptPath}:`, script] : []),
  ];
  return sourceOf(scope, 'hook', id, lines.join('\n'));
}

/** Скрипт каталога скриптов (`hooks/`) — только общий: у проекта своего каталога панель не ведёт. */
export function scriptSource(deps: MemberDeps, id: string): DescribeSource | undefined {
  try {
    const text = readScriptContent(deps.paths.hooks, id);
    return sourceOf({ kind: 'global' }, 'script', id, text.slice(0, SCRIPT_LIMIT));
  } catch {
    return undefined;
  }
}

/** Вложенная группа: её имя, описание и состав. */
function groupSource(groups: readonly Group[], id: string): DescribeSource | undefined {
  const nested = groups.find((item) => item.id === id);
  if (!nested) return undefined;
  const text = [
    `name: ${nested.name}`,
    ...(nested.description ? [`description: ${nested.description}`] : []),
    ...(nested.when ? [`when: ${nested.when}`] : []),
    `members: ${nested.members.map((member) => `${member.kind}:${member.id}`).join(', ')}`,
  ].join('\n');
  return sourceOf({ kind: 'global' }, 'group', id, text);
}

/** Источник описания одного ресурса; нет файла — `undefined`. */
export function resourceSource(
  deps: MemberDeps,
  scope: GroupScope,
  member: { kind: GroupMember['kind'] | 'script'; id: string },
): DescribeSource | undefined {
  if (member.kind === 'hook') return hookSource(deps, scope, member.id);
  if (member.kind === 'script') return scriptSource(deps, member.id);
  if (member.kind === 'group') return groupSource(deps.store.getGroups(), member.id);
  // Право — это само правило доступа: описывать нечего, кроме него самого.
  if (member.kind === 'permission') {
    return sourceOf({ kind: 'global' }, 'permission', member.id, `permission rule: ${member.id}`);
  }
  const content = memberContent(deps, scope, member);
  if (!content) return undefined;
  const steps = member.kind === 'skill' ? skillSteps(content.text) : [];
  return sourceOf(scope, member.kind, member.id, content.text, steps);
}
