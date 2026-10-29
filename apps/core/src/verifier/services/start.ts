import type { Fact } from '@agentdeck/contracts/core/facts';
import type { ServiceRecipe } from '@agentdeck/contracts/core/records';
import {
  EPHEMERAL_LABEL,
  execIn,
  listByLabels,
  publishedPorts,
  removeEphemeral,
  runContainer,
  type EngineHandle,
  type EngineRelease,
} from '../../platform/container-engine.ts';
import { tcpOpen } from '../../platform/net-probe.ts';
import { sleep } from '../../platform/os-kind.ts';
import { TASK_LABEL } from '../../platform/resource-scan.ts';
import { containerEnv, endpointOf, mainPort, publishPorts, readinessArgv } from './recipe.ts';
import type { ServiceStartOptions, StartedService } from './services.types.ts';

/**
 * Запуск сервиса задачи (04:124-127): контейнер на (задача, рецепт) один. Перед запуском —
 * поиск по меткам: контейнер уже есть (ядро упало после `run`) — берётся он, второй не
 * запускается. Готовность — проба внутри контейнера и открытый порт хоста; не дождались —
 * `unknown(not-ready)`, контейнер остаётся ресурсом задачи и снимается в конце (P40).
 */

export const SERVICE_LABEL = 'agentdeck.service';

export function serviceLabels(
  taskId: string,
  recipe: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { ...extra, [TASK_LABEL]: taskId, [SERVICE_LABEL]: recipe };
}

async function waitReady(
  h: EngineHandle,
  id: string,
  recipe: ServiceRecipe,
  hostPort: number | null,
  options: ServiceStartOptions,
): Promise<{ ready: true } | { ready: false; reason: string }> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? 90_000);
  const pollMs = options.pollMs ?? 500;
  const argv = readinessArgv(recipe);
  let last = 'not probed';
  while (Date.now() < deadline) {
    let inside = true;
    if (argv) {
      const got = await execIn(h, id, argv, { timeoutMs: 15_000 });
      inside = !('error' in got) && got.code === 0;
      if (!inside) last = 'error' in got ? got.error : `${argv[0]} exit ${got.code}`;
    }
    if (inside && hostPort !== null) {
      const open = await tcpOpen('127.0.0.1', hostPort, 2_000);
      if (open.open) return { ready: true };
      last = `port ${hostPort}: ${open.reason}`;
    } else if (inside) return { ready: true };
    await sleep(pollMs);
  }
  return { ready: false, reason: last };
}

export async function startService(
  h: EngineHandle,
  taskId: string,
  recipe: ServiceRecipe,
  options: ServiceStartOptions = {},
): Promise<Fact<StartedService>> {
  const labels = serviceLabels(taskId, recipe.name, options.extraLabels);
  const existing = await listByLabels(h, { ...labels, [EPHEMERAL_LABEL]: '1' });
  if ('unknown' in existing) return { unknown: `engine-down: ${existing.unknown}` };
  const running =
    'value' in existing ? existing.value.find((row) => row.state === 'running') : undefined;
  let id: string;
  let reused = false;
  if (running) {
    id = running.id;
    reused = true;
  } else {
    const started = await runContainer(h, {
      image: recipe.image,
      labels,
      env: containerEnv(recipe),
      ports: publishPorts(recipe),
    });
    if (!('value' in started)) {
      return {
        unknown: `start ${recipe.name}: ${'unknown' in started ? started.unknown : 'no id'}`,
      };
    }
    id = started.value;
  }
  const main = mainPort(recipe);
  let hostPort: number | null = null;
  if (main !== null) {
    const ports = await publishedPorts(h, id);
    if (!('value' in ports)) {
      return { unknown: `ports of ${recipe.name}: ${'unknown' in ports ? ports.unknown : 'gone'}` };
    }
    hostPort = ports.value[main] ?? null;
    if (hostPort === null) return { unknown: `ports of ${recipe.name}: ${main} not published` };
  }
  const ready = await waitReady(h, id, recipe, hostPort, options);
  if (!ready.ready) {
    return { unknown: `not-ready: ${recipe.name} (${id.slice(0, 12)}): ${ready.reason}` };
  }
  return {
    value: {
      recipe: recipe.name,
      engineId: id,
      hostPort,
      endpoint: hostPort === null ? null : endpointOf(recipe, hostPort),
      reused,
    },
  };
}

/** Снятие сервиса задачи: только контейнер с метками этой задачи и рецепта. */
export function stopService(
  h: EngineHandle,
  taskId: string,
  recipe: string,
  engineId: string,
): Promise<EngineRelease> {
  return removeEphemeral(h, engineId, serviceLabels(taskId, recipe));
}
