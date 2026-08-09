import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { ProjectTestRun, ProjectTestRunRequest } from '@claude-control/contracts';
import { ChatRun, type ChatEvent } from '../chat/ChatRunner.ts';
import { ProjectTestsError, readGroups, resetStatuses } from './store.ts';
import { buildPrompt, runName } from './prompt.ts';

/**
 * Прогоны тестов: генерация кейсов и их проверка.
 *
 * Отдельный реестр, а не ветка чата, — намеренно. Прогон длинный и шумный:
 * сотня кейсов — это тысячи вызовов инструментов, и в ленте разговора после
 * такого не найти ни одного человеческого сообщения. Здесь он идёт своей
 * сессией, а панель показывает результат списком галочек.
 *
 * Прогресс панель берёт НЕ отсюда: статусы пишет сам агент в файлы кейсов, и
 * клиент перечитывает их, пока прогон идёт. Дублировать это состояние в памяти
 * значило бы завести второй источник правды, который разъедется с первым.
 *
 * Реестр живёт дольше запроса, поэтому создаётся в `index.ts` — только оттуда
 * прогоны можно погасить при выходе панели.
 */

/** Хвост лога: полный вывод агента за сотню кейсов — это мегабайты. */
const MAX_LOG = 200_000;

/** Одновременно идущий прогон на проект — один. */
export class ProjectTestRunRegistry {
  private readonly runs = new Map<string, { view: ProjectTestRun; run: ChatRun }>();

  /** Прогон проекта: идущий или последний завершившийся. */
  get(projectPath: string): ProjectTestRun | undefined {
    return this.runs.get(projectPath)?.view;
  }

  /** Все прогоны — по ним панель узнаёт, что где-то ещё идёт работа. */
  list(): ProjectTestRun[] {
    return [...this.runs.values()].map((entry) => entry.view);
  }

  /**
   * Запустить прогон. Возвращает управление сразу: агент работает в фоне, а
   * клиент видит его по `GET /api/project-tests`.
   */
  start(request: ProjectTestRunRequest, now: string): ProjectTestRun {
    const root = request.projectPath;
    if (!existsSync(root)) throw new ProjectTestsError('Каталог проекта не найден.');

    const active = this.runs.get(root);
    if (active?.view.status === 'running') {
      throw new ProjectTestsError('Прогон по этому проекту уже идёт.');
    }

    const all = readGroups(root);
    const groups = request.groupId ? all.filter((group) => group.id === request.groupId) : all;
    if (request.mode === 'run') {
      if (groups.length === 0) throw new ProjectTestsError('Прогонять нечего: кейсов нет.');
      const broken = groups.find((group) => group.error);
      if (broken) throw new ProjectTestsError(`Группа «${broken.id}»: ${broken.error}`);
      if (request.full) {
        for (const group of groups) resetStatuses(root, group.id, request.caseIds);
      }
    }

    const view: ProjectTestRun = {
      id: randomUUID(),
      projectPath: root,
      mode: request.mode,
      groupId: request.groupId,
      caseIds: request.caseIds,
      scope: request.scope,
      status: 'running',
      startedAt: now,
      log: '',
      tokens: 0,
      costUsd: 0,
    };

    // Кейсы читаем ПОСЛЕ возможного сброса статусов: иначе в задание уехали бы
    // галочки прошлого прогона, которые человек только что попросил забыть.
    const prompt = buildPrompt(request.full ? readGroups(root) : all, {
      ...request,
      groupId: request.groupId,
    });

    const run = new ChatRun();
    this.runs.set(root, { view, run });

    void run
      .start(
        {
          prompt,
          cwd: root,
          name: runName(request, groups),
          // Прогон идёт без человека: спросить разрешение не у кого, а отказ на
          // каждый вызов превратил бы любой тест в «не удалось проверить».
          // Границы держит задание — трогать разрешено только .agent/tests.
          permissionMode: 'bypassPermissions',
        },
        (event) => this.consume(root, event),
      )
      .catch((error: unknown) => {
        this.finish(root, 'error', (error as Error).message);
      });

    return view;
  }

  /** Остановить прогон человеком. Уже записанные статусы остаются. */
  stop(projectPath: string): boolean {
    const entry = this.runs.get(projectPath);
    if (!entry || entry.view.status !== 'running') return false;
    entry.run.stop();
    this.finish(projectPath, 'stopped');
    return true;
  }

  /** Погасить все прогоны — вызывается при выходе сервера панели. */
  stopAll(): void {
    for (const [path, entry] of this.runs) {
      if (entry.view.status === 'running') {
        entry.run.stop();
        this.finish(path, 'stopped');
      }
    }
  }

  /** События агента → лог и расход. Статусы кейсов пишет он сам, мимо панели. */
  private consume(projectPath: string, event: ChatEvent): void {
    const entry = this.runs.get(projectPath);
    if (!entry) return;
    const view = entry.view;

    if (event.kind === 'session') view.sessionId = event.sessionId;
    if (event.kind === 'text') view.log = tail(view.log + event.text);
    if (event.kind === 'tool') {
      view.log = tail(`${view.log}\n· ${event.name} ${summarize(event.input)}\n`);
    }
    if (event.kind === 'usage') {
      view.tokens += event.input + event.output + event.cacheRead + event.cacheCreation;
      view.costUsd += event.costUsd ?? 0;
    }
    if (event.kind === 'done') {
      view.sessionId = event.sessionId || view.sessionId;
      this.finish(projectPath, 'done');
    }
    if (event.kind === 'error') this.finish(projectPath, 'error', event.message);
  }

  private finish(projectPath: string, status: ProjectTestRun['status'], error?: string): void {
    const entry = this.runs.get(projectPath);
    if (!entry || entry.view.status !== 'running') return;
    entry.view.status = status;
    entry.view.finishedAt = new Date().toISOString();
    if (error) entry.view.error = error;
  }
}

/** Первая строка входа инструмента — по ней в логе видно, что происходит. */
function summarize(input: unknown): string {
  if (typeof input === 'string') return input.slice(0, 160);
  if (!input || typeof input !== 'object') return '';
  const record = input as Record<string, unknown>;
  const value = record.file_path ?? record.command ?? record.pattern ?? record.url ?? record.path;
  return typeof value === 'string' ? value.slice(0, 160) : '';
}

/** Лог растёт бесконечно — держим хвост: интересен конец, а не начало. */
function tail(text: string): string {
  return text.length > MAX_LOG ? text.slice(text.length - MAX_LOG) : text;
}
