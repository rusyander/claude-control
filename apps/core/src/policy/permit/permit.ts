import { relative } from 'node:path';
import { toolPlanFor } from '@agentdeck/contracts/core/model-tools';
import type { PermissionAsk } from '../../adapters/adapter.types.ts';
import { matchesAny, toSlashes } from '../../lib/glob/glob.ts';
import { CI_READ_COMMANDS } from '../../lib/publish-commands.ts';
import { homeDir } from '../../platform/os-kind.ts';
import { foldsCaseAt, isInside, pathKey } from '../../platform/paths.ts';
import { analyzeExec, matchPrefix } from './exec-argv.ts';
import { type FoldedPaths, foldedPaths, unfoldableRoot } from './context-paths.ts';
import { execPlatformPath } from './exec-paths.ts';
import { forgeFlagForms } from './forge-forms.ts';
import { skillVerdict, subagentVerdict } from './layer-permit.ts';
import { absolute, deny, underAny } from './judge-helpers.ts';
import { readVerdict } from './read-scope.ts';
import { canonicalTarget } from './target-path.ts';
import type { GlobOps, PermitContext, PermitDecision } from './permit.types.ts';

/**
 * Право сессии (06 §Session permissions, R:S2-01): одна функция на три дороги — запреты оверлея,
 * хук ядра и `agentdeck-permit`. Решает только по типизированным фактам: путь, инструмент MCP,
 * argv. Текст команды — данные для показа, по нему не запрещается ничего (подсказка — максимум).
 *
 * Разрешение человека «всё автоматически» уважается внутри этих границ: всё, что не запрещено
 * здесь, разрешено, — ровно как оно было бы разрешено вне AgentDeck.
 */

function relativeInCopy(paths: FoldedPaths, abs: string): string {
  return toSlashes(relative(pathKey(paths.copyRoot), pathKey(abs)));
}

/**
 * Маска `grantRequired` / гранта против пути копии — правилом тома (R7, как `estimate/grants.ts`):
 * Windows/macOS регистр не различают — `Migrations/1.sql` тот же файл, что `migrations/1.sql`;
 * на Linux это другой файл, и маска чужого регистра его не накрывает.
 */
function covered(
  rel: string,
  list: readonly GlobOps[],
  op: 'edit' | 'exec-db',
  fold: boolean,
): boolean {
  return list.some((g) => g.ops.includes(op) && matchesAny(rel, g.globs, fold));
}

/**
 * Единственный судья класса `permit` (P01). `stepKind` — вид шага сессии из журнала (`bindingOf`),
 * не из слов модели: шаг только для чтения (разбор задачи, план, деление, ревью, исследование,
 * отчёт) не правит файлы и не зовёт оболочку (P73) — те же классы, что переходник снимает
 * флагами CLI (`READ_ONLY_DENIED`). Здесь — второй замок на дороге `agentdeck-permit`: CLI,
 * который флаг пропустил или спросил в обход, всё равно получает отказ; неизвестный вид — тоже
 * только чтение. Без `stepKind` (запреты оверлея, хук ядра) правило вида не применяется.
 */
export function decidePermit(
  ask: PermissionAsk,
  ctx: PermitContext,
  stepKind?: string,
): PermitDecision {
  if (stepKind !== undefined && (ask.action === 'edit' || ask.action === 'exec')) {
    const tools = toolPlanFor(stepKind)?.builtins ?? 'read-only';
    if (tools === 'read-only') {
      return deny('read-only-step', `step kind ${stepKind} is read-only: no ${ask.action}`, null);
    }
  }
  switch (ask.action) {
    case 'read':
      // Область чтения (F-87): вне копии и вне `readScope` — `outside-copy`.
      return readVerdict(ask, ctx);
    case 'edit': {
      const canon = canonicalTarget(ask.target);
      if ('refuse' in canon) return deny('platform-path', `${canon.refuse}: not comparable`, null);
      const paths = foldedPaths(ctx);
      const closed = unfoldableRoot(paths);
      if (closed !== null) return deny('platform-path', closed, null);
      const abs = absolute(paths, canon.path);
      if (underAny(abs, paths.platformPaths)) {
        return deny('platform-path', 'core home and token files are never writable', null);
      }
      if (!isInside(paths.copyRoot, abs)) {
        return deny('outside-copy', 'edit outside the unit copy', null);
      }
      const rel = relativeInCopy(paths, abs);
      // Конфиг и хуки git (и файл `.git` рабочей копии) — дорога публикации мимо argv: псевдоним
      // на push, pushurl, хук. Сессия их не правит (P28). Регистр сложен `pathKey` там, где его
      // складывает файловая система: `.GIT` на Windows — тот же каталог, на Linux — чужой.
      if (rel.split('/').some((part) => part === '.git')) {
        return deny('git-internals', `edit of ${rel}: git internals are not editable`, null);
      }
      // Настройки и хуки CLI в копии (`.claude/settings.json`, `hooks`) снимают право сессии (F-12).
      if (rel.split('/')[0] === '.claude') {
        return deny(
          'cli-config',
          `edit of ${rel}: CLI settings of the copy are not editable`,
          null,
        );
      }
      // Прочие пути, которые оверлей сеанса запретил править (`deny.editPaths`: `.qwen` копии,
      // каталоги шага): тот же список, что получил CLI, сверка по ключу пути (регистр, короткие
      // имена 8.3). Пути вне копии уже отказаны выше как `outside-copy`. Несводимая запись
      // списка может накрывать любой файл копии — отказ, а не пропуск записи (H7).
      const editDenied =
        paths.unfoldable.editPaths ?? paths.editPaths.find((root) => isInside(root, abs));
      if (editDenied !== undefined) {
        return deny('denied-path', `edit of ${rel}: under a path denied for this session`, null);
      }
      const fold = foldsCaseAt(ctx.copyRoot);
      if (
        covered(rel, ctx.grantRequired, 'edit', fold) &&
        !covered(rel, ctx.grants, 'edit', fold)
      ) {
        return deny('grant-required', `edit of ${rel} needs a grant for this task`, 5);
      }
      // Свои пути — от корня копии: `src` единицы не значит чужой `pkg/src` (F-06).
      const owned = ctx.ownedPaths.length === 0 || matchesAny(rel, ctx.ownedPaths, fold, 'rooted');
      return owned
        ? { allow: true, signal: null, reason: 'edit inside owned paths' }
        : { allow: true, signal: 'ownership', reason: `edit of ${rel} outside owned paths` };
    }
    case 'exec': {
      // Префикс argv публикации — класс `publish` по разобранному argv, а не по словам текста:
      // сверяется с каждой формой каждой команды строки (P28) — опции git, псевдонимы, обёртки,
      // путь к файлу, цепочки и подстановки. Строка — `display` переходника (сырая команда).
      // Порядок: точная форма → дорога мимо argv → путь платформы → неразобранное (F-01…F-05).
      // Переходник сказал «argv мог разойтись с оболочкой», а сырого текста нет: судить не по чему.
      if (ask.argvExact === false && !ask.display.trim() && ctx.deny.commands.length > 0) {
        return deny('publish-unknown', 'argv is not exact and no shell text to read', null);
      }
      const home = homeDir();
      const analysis = analyzeExec(ask.argv ?? [], ask.display, {
        home,
        heads: ctx.deny.commands.map((prefix) => prefix[0] ?? ''),
        primary: ask.tool === 'PowerShell' ? 'ps' : 'bash',
      });
      // Флаги форджа до глагола (`gh -R o/r pr create`) — ещё формы той же команды.
      const forms = analysis.forms.flatMap(forgeFlagForms);
      const matches = ctx.deny.commands.flatMap((prefix) =>
        forms.map((form) => matchPrefix(form, prefix)),
      );
      if (matches.includes('yes')) {
        // Чтение CI — тот же список запретов, но своя причина: ждёт CI ядро, не сессия. Строка,
        // где рядом и публикация, называется публикацией — она важнее.
        const hit = (prefix: readonly string[]) =>
          forms.some((form) => matchPrefix(form, prefix) === 'yes');
        const ciKeys = new Set(CI_READ_COMMANDS.map((p) => p.join(' ')));
        const publishes = ctx.deny.commands.some((p) => !ciKeys.has(p.join(' ')) && hit(p));
        return publishes
          ? deny('platform-step', 'publishing is a platform step', null)
          : deny('platform-step', 'CI state is read by the core (task ciWait)', null);
      }
      // Псевдоним, настройка или remote, которые префикс не увидит (pushurl, hooksPath, include).
      if (analysis.hazards.length > 0 && ctx.deny.commands.some((p) => p[0] === 'git')) {
        return deny(
          'platform-step',
          `publishing road hidden from argv: ${analysis.hazards[0]}`,
          null,
        );
      }
      const paths = foldedPaths(ctx);
      const closed = unfoldableRoot(paths);
      if (closed !== null) return deny('platform-path', closed, null);
      const named = execPlatformPath(analysis, {
        copyRoot: paths.copyRoot,
        platformPaths: paths.platformPaths,
        home,
      });
      if (named !== null) {
        return deny('platform-path', `command names the core home or its ancestor: ${named}`, null);
      }
      // Файл учётных данных CLI словом команды — тот же замок, что у чтения (F-87). Прочие пути
      // вне области чтения оболочка не судит: что программа читает сама, судья не видит (06).
      const credential = execPlatformPath(analysis, {
        copyRoot: paths.copyRoot,
        platformPaths: paths.credentials,
        home,
      });
      if (credential !== null) {
        return deny('credential-path', `command names a CLI credential file: ${credential}`, null);
      }
      // Fail-closed: слово с дырой может оказаться публикацией, неразобранное — тоже.
      if (
        ctx.deny.commands.length > 0 &&
        (matches.includes('maybe') || analysis.unknown.length > 0)
      ) {
        const why =
          analysis.unknown[0] ?? 'a word the parser cannot see may complete a publishing form';
        return deny('publish-unknown', `command not fully readable: ${why}`, null);
      }
      return { allow: true, signal: null, reason: 'exec matches no publishing form' };
    }
    case 'mcp':
      if (matchesAny(ask.target, ctx.deny.mcpTools)) {
        return deny('denied-tool', `${ask.target} is in the platform deny set`, null);
      }
      return { allow: true, signal: null, reason: 'mcp tool not denied' };
    case 'net':
      return { allow: true, signal: null, reason: 'network' };
    case 'conversation':
      // Трогает только разговор CLI: отказ лишил бы шаг инструментов ядра (F-89, H1).
      return { allow: true, signal: null, reason: 'conversation-internal tool' };
    case 'skill':
      return skillVerdict(ask, ctx);
    case 'subagent':
      return subagentVerdict(ask, ctx, stepKind);
    default:
      // Класс, которого политика не знает, не разрешается молча.
      return deny('unknown-action', `unknown action class for ${ask.tool}`, null);
  }
}
