// Процесс ядра проверки распределителя (этап 11, P141-P142): настоящая загрузка с исполнителем на
// своём одноразовом доме, каталог машины — из `AGENTDECK_CORE_MACHINE` (его ставит тест, общий
// для двух ядер). CLI подставной (запись живого Claude под именем `claude` на PATH пина), его дом
// одноразовый. Настройка — base64url JSON в argv[2]; записи — строки JSON в `notes`.
// Ядро ведёт задачи, пока тест не положит файл `stop` рядом с домом или не убьёт процесс.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LimitFact } from '@agentdeck/contracts/core/economy';
import { claudeRunFacts } from '@agentdeck/providers/claude';
import { livePin, liveRoot } from '../../../adapters/conformance/__fixtures__/live.ts';
import {
  fixturePath,
  installReplay,
  replayEnv,
} from '../../../adapters/conformance/__fixtures__/replay.ts';
import { writeLibraryScenario } from '../../../conductor/scenario/index.ts';
import { presetStep } from '../../../conductor/scenario/presets.ts';
import { createCliLoginRoute } from '../../../routes/cli-login/cli-login.ts';
import { ownDir, ownOptions } from '../../../routes/local/own/__fixtures__/own-options.ts';
import { createOwnRoute } from '../../../routes/local/own/own.ts';
import { createLiveRouteRegistry } from '../../../routes/registry.ts';
import { CREATED, MINI_SCENARIO } from '../../../journal/__fixtures__/journal-harness.ts';
import { newId } from '../../../lib/ids/uuidv7.ts';
import { bootCore } from '../../boot.ts';
import type { BootOptions } from '../../boot/boot.types.ts';
import { loginRoute } from '../../__fixtures__/road-start.ts';

export interface AllocatorChild {
  home: string;
  notes: string;
  repo: string;
  tasks: number;
  units: number;
  /** Раздел `queue` и `lead` настройки дома ядра. */
  config: Record<string, unknown>;
  /** Факт окна, который ядро видит сразу после загрузки (как от своей сессии). */
  inject?: LimitFact;
  /** Настройки наблюдателя загрузки (частота сверки хостов сеансов). */
  observer?: BootOptions['observer'];
  /**
   * Своя модель машины: маршрут `local:own` над подставным llama-server (раннер — модель-заглушка
   * `@agentdeck/stub-model`) в этом каталоге; задачи ядра идут только им. Нет — вход CLI.
   */
  own?: string;
  /** Сколько чатов (сценарий из одного шага `chat`) завести вслед за задачами. */
  chats?: number;
  /**
   * CLI переживает хост сеанса на столько мс (`REPLAY_OUTLIVE_MS`): Windows не снимает детей с
   * родителем, и живой CLI доделывает ход после ухода клиента. Нет — выходит с концом stdin.
   */
  outliveHostMs?: number;
}

const raw = process.argv[2];
if (!raw) throw new Error('usage: allocator-child.ts <base64url config>');
const cfg = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as AllocatorChild;
const note = (event: string, data: Record<string, unknown> = {}): void => {
  appendFileSync(
    cfg.notes,
    `${JSON.stringify({ at: Date.now(), pid: process.pid, event, ...data })}\n`,
  );
};

mkdirSync(cfg.home, { recursive: true });
writeFileSync(join(cfg.home, 'config.json'), JSON.stringify(cfg.config));
const live = liveRoot('alloc-cli-');
const bin = join(live.root, 'bin');
mkdirSync(bin, { recursive: true });
installReplay(bin, claudeRunFacts.binary.command);
const dump = join(live.root, 'dump.json');

const core = await bootCore({
  home: cfg.home,
  build: `alloc-${process.pid}`,
  loginPath: async () => ({
    path: process.env.PATH ?? '',
    source: 'known-dirs',
    reason: 'test login path',
  }),
  loop: {
    pin: () => ({
      ...livePin(live, replayEnv({ fixture: fixturePath('claude', 'basic'), dump })),
      REPLAY_MAX_MS: '240000',
      ...(cfg.outliveHostMs ? { REPLAY_OUTLIVE_MS: String(cfg.outliveHostMs) } : {}),
    }),
    pathPrefix: [bin, dirname(process.execPath)],
    sweepMs: 100,
  },
  ...(cfg.observer ? { observer: cfg.observer } : {}),
  // Своя модель — свой «GPU» у каждого ядра (каталог памяти и аренд в `own`): между ядрами её
  // одну-за-раз держит только распределитель мест, не очередь слота маршрута.
  ...(cfg.own
    ? {
        routes: createLiveRouteRegistry([
          createCliLoginRoute({ id: claudeRunFacts.id }),
          createOwnRoute(ownOptions(ownDir(cfg.own))),
        ]),
      }
    : {}),
});
note('boot', { url: core.url, cliRoot: live.root });
if (cfg.inject) {
  core.windows.observe({ ...cfg.inject, at: Date.now() });
  note('injected', { routeId: cfg.inject.routeId });
}

async function launch(taskId: string): Promise<number> {
  const token = readFileSync(core.layout.token, 'utf8').trim();
  const auth = { authorization: `Bearer ${token}` };
  const page = newId();
  const minted = await fetch(`${core.url}/v1/nonce?page=${page}`, { headers: auth });
  const { nonce } = (await minted.json()) as { nonce: string };
  const res = await fetch(`${core.url}/v1/commands`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      cmdId: newId(),
      kind: 'launch',
      target: { taskId },
      fields: {},
      proof: { nonce, page },
    }),
  });
  return res.status;
}

/** Чат — сценарий из одного шага `chat`: сеанс живёт, пока человек его не закроет. */
const CHAT_SCENARIO = {
  id: 'alloc-chat',
  version: 1,
  title: 'чат',
  steps: [presetStep('chat', 'chat', 'Чат', [])],
};

// Без потолка: модель по умолчанию CLI (запись отвечает своей моделью — с потолком наблюдатель
// снял бы сеанс за несовпадение поданной модели). Своя модель — модель из списка маршрута.
const ALLOWED = cfg.own
  ? [
      {
        adapter: claudeRunFacts.id,
        route: { kind: 'local' as const, id: 'local:own' },
        modelPattern: 'tiny-model',
      },
    ]
  : [
      {
        adapter: claudeRunFacts.id,
        route: { kind: 'cli-login' as const, id: loginRoute(claudeRunFacts.id) },
        modelPattern: '*',
      },
    ];

try {
  await writeLibraryScenario(core.layout.scenarios, MINI_SCENARIO);
  await writeLibraryScenario(core.layout.scenarios, CHAT_SCENARIO);
  const kinds = [
    ...Array.from({ length: cfg.tasks }, () => 'task' as const),
    ...Array.from({ length: cfg.chats ?? 0 }, () => 'chat' as const),
  ];
  for (const [t, kind] of kinds.entries()) {
    const task = await core.registry.create({
      ...CREATED,
      title: `alloc ${kind} ${t}`,
      repos: [{ repoKey: 'r1', path: cfg.repo, baseRef: 'main' }],
      ...(kind === 'chat' ? { scenario: { id: CHAT_SCENARIO.id, version: 1 } } : {}),
      modelCeiling: null,
      allowedRoutes: ALLOWED,
    });
    // Единицы до запуска: задача сразу просит места всем, как после деления; у чата одна.
    const units = kind === 'chat' ? 1 : cfg.units;
    for (let u = 0; u < units; u += 1) {
      const unitId = newId();
      task.append({
        kind: 'unit.created',
        actor: 'core',
        unitId,
        data: {
          unitId,
          name: `u${u}`,
          repoKey: 'r1',
          branch: `alloc-${task.taskId.slice(-8)}-${u}`,
          ownedPaths: [`area${u}/**`],
          after: [],
          contract: false,
          splitId: null,
        },
      });
    }
    note(kind, { taskId: task.taskId, launch: await launch(task.taskId) });
  }
  const stopFile = join(cfg.home, '..', 'stop');
  while (!existsSync(stopFile)) await new Promise((r) => setTimeout(r, 100));
} catch (error) {
  note('error', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
  process.exitCode = 3;
} finally {
  await core.stop();
  // Как вход ядра (`index.ts`: `core.stop()` → `process.exit`): `stop('keep')` оставляет живые
  // сеансы и каналы их насосов к хостам — сами по себе они держали бы процесс вечно.
  note('stopped', { resources: process.getActiveResourcesInfo() });
  process.exit(process.exitCode ?? 0);
}
