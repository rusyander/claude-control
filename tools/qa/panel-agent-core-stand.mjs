/**
 * Одноразовый стенд для хода агента панели через ядро (этап 10): панель + своё ядро + НАСТОЯЩИЙ
 * CLI (по умолчанию `claude`) + заглушка модели по программе проверки
 * (`packages/stub-model/src/scenarios/panel-agent.mjs`).
 *
 * Путь целиком настоящий: `POST /api/agent/run` → вопрос ядра «ask» → сессия ядра с CLI, у которой
 * из инструментов только мост `panel-bridge` (`tools/mcp/panel.mjs`) → действия панели → карточки.
 * Подменена только модель: профиль «Ассистент панели» — свой адрес на заглушку, ключ — в
 * хранилище панели, ядро берёт его маршрутом `api-key:endpoint:stub` (реестр строится при
 * загрузке ядра из `state.json` панели — поэтому профиль кладётся до старта, а каталог панели
 * ядру называется явно, `AGENTDECK_PANEL_DATA`).
 *
 * Нет CLI — «не проверено» (код 2), а не провал: проверка без CLI ничего не доказывает.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { NotChecked, runOnStand } from './throwaway-stand.mjs';
import { startPanelAgentModel } from '../../packages/stub-model/src/scenarios/panel-agent.mjs';

export const STUB_PROFILE = 'stub';
const STUB_KEY = 'stand-stub-key';

/** Каталог CLI в PATH человека (стенд прячет `claude` из PATH, возвращаем его явно). */
export function cliDir(name) {
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], {
    encoding: 'utf8',
  });
  const first = (found.stdout ?? '').split(/\r?\n/)[0]?.trim();
  return found.status === 0 && first ? dirname(first) : undefined;
}

/**
 * Запустить сценарий на стенде. `program` — ход модели (см. сценарий пакета), `cli` — какой CLI
 * активен (`claude` | `qwen`), `apiKind` профиля — вид API этого CLI. Сценарий получает
 * `(stand, check, model)`; `model.turns` — что дошло до модели. `modelOptions` — опции заглушки
 * (`route` — наблюдатель сырых запросов, без ответа). `model` — уже запущенная заглушка со
 * своим сценарием (проверка, где модель отвечает не только агенту панели): тогда `program` и
 * `modelOptions` не нужны, а закрывает её всё равно этот вызов.
 */
export async function runPanelAgentOnCore(
  {
    label,
    program,
    model: ownModel,
    cli = 'claude',
    apiKind = 'anthropic',
    seed,
    settings = {},
    env = {},
    modelOptions = {},
    ...rest
  },
  scenario,
) {
  const dir = cliDir(cli);
  const model = ownModel ?? (await startPanelAgentModel(program, modelOptions));
  const standEnv = { ...env };
  try {
    await runOnStand(
      {
        label,
        ...rest,
        core: true,
        web: true,
        ...(dir ? { extraPath: [dir] } : {}),
        env: standEnv,
        seed: async (paths) => {
          standEnv.AGENTDECK_PANEL_DATA = join(paths.cfg, 'agentdeck');
          if (seed) await seed(paths);
        },
        settings: {
          provider: cli,
          endpointProfiles: [
            {
              id: STUB_PROFILE,
              name: 'Stub',
              baseUrl: apiKind === 'openai-compat' ? `${model.baseUrl}/v1` : model.baseUrl,
              apiKind,
              model: 'stub-model',
              writeToken: false,
              imagesUrl: '',
              ownerPlatformId: '',
            },
          ],
          assistantEndpointId: STUB_PROFILE,
          ...settings,
        },
      },
      async (stand, check) => {
        if (!dir) throw new NotChecked(`${cli} нет в PATH`);
        const token = await stand.api(`/endpoints/${STUB_PROFILE}/token`, {
          method: 'PUT',
          // Запись пускается только с Origin фронта стенда — стенд здесь всегда с фронтом.
          headers: { origin: stand.webUrl },
          body: { token: STUB_KEY },
        });
        if (token.status !== 200)
          throw new Error(`ключ заглушки: HTTP ${token.status} ${token.text}`);
        await scenario(stand, check, model);
      },
    );
  } finally {
    await model.close();
  }
}
