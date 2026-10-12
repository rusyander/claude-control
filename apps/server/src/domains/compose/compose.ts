import type { ComposeInfo } from '@agentdeck/contracts';
import { composeFingerprint, findComposeFile, type ComposeLocation } from './compose-file.ts';
import { DockerStateProbe, shortDetail, type DockerExec } from './docker.ts';
import {
  mergeServices,
  parseConfig,
  parsePs,
  type ContainerRow,
  type DeclaredStack,
} from './parse.ts';
import type { ComposeRegistry } from './registry.ts';

export { findComposeFile, COMPOSE_DIRS, COMPOSE_NAMES } from './compose-file.ts';
export { ComposeRegistry, ComposeBusyError, composeArgs } from './registry.ts';
export { execDocker, spawnDocker } from './docker.ts';
export type { DockerExec, DockerJobProcess, DockerSpawn } from './docker.ts';

/**
 * Compose проекта для окна «Окружение». Источник правды — docker: состав
 * стека из `compose config` (с подставленными переменными и override), живое
 * состояние из `compose ps`. Панель ничего не хранит и не угадывает.
 */
export class ComposeReader {
  private readonly exec: DockerExec;
  private readonly docker: DockerStateProbe;
  /** Разобранный `compose config` по каталогу файла — до изменения файлов или `.env`. */
  private readonly configs = new Map<
    string,
    { fingerprint: string; stack?: DeclaredStack; error?: string }
  >();

  constructor(exec: DockerExec, now?: () => number) {
    this.exec = exec;
    this.docker = new DockerStateProbe(exec, now);
  }

  forgetDocker(): void {
    this.docker.forget();
  }

  /** Состав стека: `undefined` с ошибкой — файл есть, но docker его не принял. */
  async declared(location: ComposeLocation): Promise<{ stack?: DeclaredStack; error?: string }> {
    const fingerprint = composeFingerprint(location);
    const cached = this.configs.get(location.dir);
    if (cached?.fingerprint === fingerprint) return cached;
    const result = await this.exec(['compose', 'config', '--format', 'json'], location.dir, 30_000);
    let entry: { fingerprint: string; stack?: DeclaredStack; error?: string };
    if (result.code !== 0) {
      entry = { fingerprint, error: shortDetail(result.stderr || result.stdout, 2000) };
    } else {
      try {
        entry = { fingerprint, stack: parseConfig(result.stdout) };
      } catch {
        entry = { fingerprint, error: shortDetail(result.stdout, 2000) };
      }
    }
    // Таймаут — не ответ про файл: повторим на следующем опросе.
    if (result.code !== null) this.configs.set(location.dir, entry);
    return entry;
  }

  async describe(projectPath: string, registry?: ComposeRegistry): Promise<ComposeInfo> {
    const location = findComposeFile(projectPath);
    const job = registry?.jobOf(projectPath);
    const docker = await this.docker.read(location?.dir ?? projectPath);
    const base: ComposeInfo = {
      projectPath,
      docker: docker.state,
      ...(docker.detail ? { dockerDetail: docker.detail } : {}),
      ...(location ? { file: location.file } : {}),
      files: location?.files ?? [],
      services: [],
      volumes: [],
      ...(job ? { job } : {}),
    };
    if (!location || docker.state === 'missing') return base;

    const { stack, error } = await this.declared(location);
    if (!stack) return { ...base, configError: error ?? '' };
    const declaredInfo = {
      ...base,
      ...(stack.projectName ? { projectName: stack.projectName } : {}),
      volumes: stack.volumes,
    };
    // Демон стоит — состав из файла виден, а состояние контейнеров спросить не у кого.
    if (docker.state !== 'ok') return declaredInfo;

    const ps = await this.exec(
      ['compose', 'ps', '--all', '--format', 'json'],
      location.dir,
      20_000,
    );
    if (ps.code !== 0) {
      this.docker.forget();
      return { ...declaredInfo, services: mergeServices(stack, []) };
    }
    let rows: ContainerRow[];
    try {
      rows = parsePs(ps.stdout);
    } catch {
      rows = [];
    }
    return { ...declaredInfo, services: mergeServices(stack, rows) };
  }
}
