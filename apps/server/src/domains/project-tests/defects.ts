import { spawnSync } from 'node:child_process';
import type {
  DefectDraft,
  DefectTarget,
  ProjectTestCase,
  ProjectTestPointResult,
  ProjectTestStep,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';
import type { AppStore } from '../../lib/app-store.ts';
import { findCliOnPath } from '../../providers/detect.ts';
import { toAccess } from '../integrations/atlassian/client.ts';
import { createIssue } from '../integrations/atlassian/jira.ts';
import { createForgeIssue, toForgeAccess } from '../integrations/forge.ts';
import { linkForCwd } from '../integrations/links.ts';
import { readIntegrations, readToken, requireConnected } from '../integrations/store.ts';
import { ProjectTestsError } from './files.ts';

/**
 * Дефект по проваленному кейсу: черновик и, если есть чем, заведение задачи.
 *
 * Черновик собирается ВСЕГДА — из шагов, ожидания и того, что человек или агент
 * увидел на самом деле. Это половина работы тестировщика, и она не должна
 * зависеть от того, подключён ли трекер.
 *
 * Путей заведения теперь четыре, и они не равнозначны:
 *
 * - `github`/`gitlab` — установленные у человека `gh`/`glab`. Панель не хранит
 *   ради них ни одного секрета, поэтому этот путь остаётся НАВСЕГДА и работает
 *   там, где токена нет и не будет;
 * - `forge` — тот же фордж, но по сохранённому токену: на машине без CLI это
 *   единственный способ, а второго секрета он не требует — тот же токен уже
 *   заведён ради подхвата отчётов CI;
 * - `jira` — трекер, в котором дефект и живёт у команды.
 *
 * Список доступного считается ЖИВЫМ (`availableTargets`), а не берётся из
 * настройки: CLI ставят и сносят, токен выкидывают, и предложить кнопку,
 * которая заведомо откажет, хуже, чем не предложить её вовсе.
 */

/** Кандидаты имён CLI: на Windows это ещё и `.cmd`-обёртка npm. */
const GH = process.platform === 'win32' ? ['gh.cmd', 'gh'] : ['gh'];
const GLAB = process.platform === 'win32' ? ['glab.cmd', 'glab'] : ['glab'];

/**
 * Шаги в нумерованный список — так их читают в задаче.
 *
 * Провалившийся помечается прямо в списке: тот, кто чинит, ищет глазами место,
 * а не сверяет номер из соседнего абзаца со списком из десяти пунктов.
 */
function stepsBlock(steps: ProjectTestStep[], failed?: number): string {
  return steps
    .map((step, index) => {
      const line = `${index + 1}. ${stepText(step)}`;
      return index + 1 === failed ? `${line} ← провал` : line;
    })
    .join('\n');
}

/**
 * Что нужно, чтобы узнать про подключённые по токену системы.
 *
 * Не обязательно: черновик собирается и без них — тогда в списке остаются
 * только CLI. Так `buildDraft` продолжает работать там, где интеграций нет
 * вовсе, и не тащит за собой состояние панели ради текста задачи.
 */
export interface DefectDeps {
  store: AppStore;
  appDataDir: string;
  /** Каталог проверяемого проекта: по нему находится привязка к Jira. */
  root?: string;
}

/** Черновик дефекта: заголовок и тело задачи. */
export function buildDraft(
  testCase: ProjectTestCase,
  context: {
    groupId: string;
    environmentTitle?: string;
    branch?: string;
    commit?: string;
    result?: ProjectTestPointResult;
    logTail?: string;
    deps?: DefectDeps;
  },
): DefectDraft {
  // Разбор провала — от того прохода, по которому дефект и заводят; у кейса он
  // лежит от последнего прогона и годится, когда дефект заводят из библиотеки.
  const failure = context.result?.failure ?? testCase.failure;
  const actual = failure?.actual ?? context.result?.note ?? testCase.note ?? 'не описано';
  const step = failure?.step;
  const lines = [
    `**Кейс:** ${context.groupId}/${testCase.id} — ${testCase.title}`,
    testCase.area ? `**Зона:** ${testCase.area}` : '',
    context.environmentTitle ? `**Окружение:** ${context.environmentTitle}` : '',
    context.branch
      ? `**Ветка:** ${context.branch}${context.commit ? ` (${context.commit})` : ''}`
      : '',
    '',
    testCase.precondition ? `**Предусловие**\n${testCase.precondition}\n` : '',
    '**Шаги**',
    stepsBlock(testCase.steps, step) || '— не описаны',
    '',
    // Ожидание берётся с провалившегося шага, если оно там названо: общий итог
    // сценария в дефекте отвечает на «что хотели», а чинят по конкретному шагу.
    `**Ожидалось**\n${failure?.expected ?? testCase.expected ?? 'не описано'}`,
    '',
    `**Получилось**\n${actual}`,
    step ? `\n**Провалился шаг ${step}**` : '',
    // Разошедшиеся попытки — это отдельный факт: чинить в таком случае нужно
    // сначала сам тест, и дефект обязан сказать об этом сразу.
    failure?.retry === 'flaky'
      ? `\n**Вторая попытка разошлась**\n${failure.retryNote ?? 'во второй раз вышло иначе'}`
      : '',
    failure?.retry === 'confirmed' ? '\n**Вторая попытка:** то же самое, провал подтверждён.' : '',
    context.result?.attachments?.length
      ? `\n**Доказательства**\n${context.result.attachments.map((file) => `- ${file}`).join('\n')}`
      : '',
    context.logTail
      ? `\n<details><summary>Лог прогона</summary>\n\n\`\`\`\n${context.logTail}\n\`\`\`\n</details>`
      : '',
  ];

  return {
    title: `[${testCase.area ?? context.groupId}] ${testCase.title}`,
    body: lines.filter((line) => line !== '').join('\n'),
    targets: availableTargets(context.deps),
    hint: hintOf(context.deps),
  };
}

/**
 * Куда можно завести задачу ПРЯМО СЕЙЧАС. Порядок — от самого специфичного к
 * запасному: команда, у которой есть Jira, ждёт дефект именно там.
 */
export function availableTargets(deps?: DefectDeps): DefectTarget[] {
  const targets: DefectTarget[] = [];
  if (jiraProjectOf(deps)) targets.push('jira');
  if (forgeReady(deps)) targets.push('forge');
  if (findCliOnPath(GH)) targets.push('github');
  if (findCliOnPath(GLAB)) targets.push('gitlab');
  return targets;
}

/** Чем именно панель заведёт задачу — это видно человеку до нажатия. */
function hintOf(deps?: DefectDeps): string | undefined {
  const parts = [
    jiraProjectOf(deps) ? `Jira ${jiraProjectOf(deps)}` : '',
    forgeReady(deps) ? forgeTitle(deps) : '',
    findCliOnPath(GH) ?? '',
    findCliOnPath(GLAB) ?? '',
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : undefined;
}

/**
 * Проект Jira для дефектов: только из привязки, сделанной человеком.
 *
 * Угадывать его нельзя ни при каких условиях: дефект, улетевший в чужой проект,
 * увидит не та команда, а забрать его обратно панель не умеет.
 */
function jiraProjectOf(deps?: DefectDeps): string | undefined {
  if (!deps?.root) return undefined;
  try {
    const settings = readIntegrations(deps.store).atlassian;
    if (!settings.enabled || !readToken(deps.appDataDir, 'atlassian')) return undefined;
    return linkForCwd(deps.store, deps.root)?.link.jiraProjectKey || undefined;
  } catch {
    // Состояние панели недоступно (нерасшифрованное хранилище, битый файл) —
    // назначения просто нет. Черновик от этого не страдает, а он и есть главное.
    return undefined;
  }
}

function forgeReady(deps?: DefectDeps): boolean {
  if (!deps) return false;
  try {
    const settings = readIntegrations(deps.store).forge;
    if (!settings.enabled || !settings.kind) return false;
    return Boolean(readToken(deps.appDataDir, 'forge'));
  } catch {
    return false;
  }
}

function forgeTitle(deps?: DefectDeps): string {
  try {
    return deps && readIntegrations(deps.store).forge.kind === 'gitlab'
      ? 'GitLab по токену'
      : 'GitHub по токену';
  } catch {
    return 'фордж по токену';
  }
}

/**
 * Завести задачу по СОХРАНЁННОМУ токену — Jira или фордж.
 *
 * Отдельно от `createDefect`: тот запускает чужой CLI и ничего не знает про
 * сеть, этот ходит наружу сам и потому асинхронный. Общего у них ровно текст
 * задачи, и склеивать их в одну функцию значило бы получить третью, которая
 * умеет и то, и другое наполовину.
 */
export async function createTokenDefect(
  deps: DefectDeps,
  target: 'jira' | 'forge',
  title: string,
  body: string,
): Promise<string> {
  if (target === 'jira') {
    const projectKey = jiraProjectOf(deps);
    if (!projectKey) {
      throw new ProjectTestsError(
        'К проекту не привязан проект Jira — привяжите его на карточке проекта.',
      );
    }
    const token = requireConnected(deps.store, deps.appDataDir, 'atlassian', 'Atlassian');
    const access = toAccess(readIntegrations(deps.store).atlassian, token);
    const issue = await createIssue(access, { projectKey, summary: title, description: body });
    return issue.url;
  }

  const token = requireConnected(deps.store, deps.appDataDir, 'forge', 'Фордж');
  const access = toForgeAccess(readIntegrations(deps.store).forge, token, deps.root);
  const issue = await createForgeIssue(access, title, body);
  return issue.url;
}

/**
 * Завести задачу. Возвращает ссылку — её панель пишет в кейс.
 *
 * Тело уходит через аргумент, а не через stdin: `gh` и `glab` принимают его
 * одинаково, а лишний канал на Windows — это ещё один способ потерять кавычки.
 */
export function createDefect(
  root: string,
  target: 'github' | 'gitlab',
  title: string,
  body: string,
): string {
  const command = findCliOnPath(target === 'github' ? GH : GLAB);
  if (!command) {
    throw new ProjectTestsError(
      target === 'github'
        ? 'Не найден gh — поставьте GitHub CLI или скопируйте черновик руками.'
        : 'Не найден glab — поставьте GitLab CLI или скопируйте черновик руками.',
    );
  }

  const args =
    target === 'github'
      ? ['issue', 'create', '--title', title, '--body', body]
      : ['issue', 'create', '--title', title, '--description', body];

  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
  });

  if (result.error)
    throw new ProjectTestsError(`Не удалось запустить ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new ProjectTestsError(
      `${command} отказался заводить задачу: ${reason || 'без объяснения'}`,
    );
  }

  const url = `${result.stdout ?? ''}`.match(/https?:\/\/\S+/)?.[0];
  if (!url) throw new ProjectTestsError(`${command} не вернул ссылку на задачу.`);
  return url;
}
