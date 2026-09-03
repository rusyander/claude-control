import type { ServerContext } from '../context.ts';
import type { startSandboxHousekeeping } from '../domains/sandbox/SandboxConfig.ts';
import type { autostartProjects } from '../domains/project-runner.ts';

export interface BannerInput {
  host: string;
  port: number;
  location: ServerContext['location'];
  sandboxSweep: ReturnType<typeof startSandboxHousekeeping>;
  autostarted: Awaited<ReturnType<typeof autostartProjects>>;
  /** Строка о прокси защиты данных; пустая — прокси выключен. */
  dlpNote: string;
}

/**
 * Что печатается в терминал после старта: адрес, каталог конфигурации и всё,
 * что человеку стоит увидеть сразу, — недоступный каталог, брошенные песочницы,
 * судьба автозапусков. Чистая функция над уже собранными фактами.
 */
export function startupBanner(input: BannerInput): string {
  const { host, port, location, sandboxSweep, autostarted, dlpNote } = input;

  return [
    `Claude Control API: http://${host}:${port}`,
    `Каталог конфигурации: ${location.paths.root} (источник: ${location.source})`,
    location.isValid ? '' : `ВНИМАНИЕ: ${location.problem ?? 'каталог недоступен'}`,
    location.missing.length > 0 ? `Не найдено: ${location.missing.join(', ')}` : '',
    sandboxSweep.removed.length > 0
      ? `Убрано брошенных песочниц: ${sandboxSweep.removed.length} (в них лежала копия учётных данных)`
      : '',
    // Отказ уборки виден и здесь, а не только в потоке ошибок: внутри такой
    // папки осталась копия доступа к аккаунту, и убрать её может только человек.
    ...sandboxSweep.failed.map(
      (item) => `Песочницу не удалось убрать: ${item.path} — ${item.error}`,
    ),
    // Порт печатает сам dev-сервер, и к этому моменту он обычно ещё не назвался —
    // поэтому в строке либо уже известный порт, либо честное «адрес будет в панели».
    ...autostarted.started.map(
      (run) => `Автозапуск: ${run.path}${run.port ? ` → порт ${run.port}` : ' (адрес — в панели)'}`,
    ),
    ...autostarted.failed.map((run) => `Автозапуск не удался: ${run.path} — ${run.message}`),
    dlpNote,
    '',
  ]
    .filter(Boolean)
    .join('\n');
}
