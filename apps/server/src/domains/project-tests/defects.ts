import { spawnSync } from 'node:child_process';
import type {
  ProjectTestCase,
  ProjectTestDefectDraft,
  ProjectTestPointResult,
  ProjectTestStep,
} from '@agentdeck/contracts';
import { stepText } from '@agentdeck/contracts/test-format';
import { findCliOnPath } from '../../providers/detect.ts';
import { ProjectTestsError } from './files.ts';

/**
 * Дефект по проваленному кейсу: черновик и, если есть чем, заведение задачи.
 *
 * Черновик собирается ВСЕГДА — из шагов, ожидания и того, что человек или агент
 * увидел на самом деле. Это половина работы тестировщика, и она не должна
 * зависеть от того, подключён ли трекер.
 *
 * Заводить задачу панель умеет только тем, что уже стоит у человека: `gh` для
 * GitHub, `glab` для GitLab. Своих токенов она не просит и в сеть сама не
 * ходит — иначе пришлось бы хранить чужие секреты ради одной кнопки.
 */

/** Кандидаты имён CLI: на Windows это ещё и `.cmd`-обёртка npm. */
const GH = process.platform === 'win32' ? ['gh.cmd', 'gh'] : ['gh'];
const GLAB = process.platform === 'win32' ? ['glab.cmd', 'glab'] : ['glab'];

/** Шаги в нумерованный список — так их читают в задаче. */
function stepsBlock(steps: ProjectTestStep[]): string {
  return steps.map((step, index) => `${index + 1}. ${stepText(step)}`).join('\n');
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
  },
): ProjectTestDefectDraft {
  const actual = context.result?.note ?? testCase.note ?? 'не описано';
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
    stepsBlock(testCase.steps) || '— не описаны',
    '',
    `**Ожидалось**\n${testCase.expected ?? 'не описано'}`,
    '',
    `**Получилось**\n${actual}`,
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
    targets: availableTargets(),
    hint: hintOf(),
  };
}

/** Куда можно завести задачу прямо отсюда. */
export function availableTargets(): ProjectTestDefectDraft['targets'] {
  const targets: ProjectTestDefectDraft['targets'] = [];
  if (findCliOnPath(GH)) targets.push('github');
  if (findCliOnPath(GLAB)) targets.push('gitlab');
  return targets;
}

/** Чем именно панель заведёт задачу — это видно человеку до нажатия. */
function hintOf(): string | undefined {
  const gh = findCliOnPath(GH);
  const glab = findCliOnPath(GLAB);
  if (gh && glab) return `${gh} / ${glab}`;
  return gh ?? glab;
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
