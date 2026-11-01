import type { FastifyInstance } from 'fastify';
import { commandIssues } from '@agentdeck/contracts/core/commands';
import {
  saveScenarioBodySchema,
  type ScenarioSaveReply,
  type ScenariosReply,
} from '@agentdeck/contracts/core/panel-api';
import { scenarioProblems, scenarioRefSchema } from '@agentdeck/contracts/core/scenario';
import {
  isPresetId,
  latestPresets,
  latestVersion,
  listLibrary,
  presetOf,
  PRESETS,
  readLibraryScenario,
  writeLibraryScenario,
} from '../conductor/scenario/index.ts';
import { decideAuthority } from '../policy/authority/authority.ts';
import { proofOfBody } from './body-proof.ts';
import { apiError, commandStatus } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET /v1/scenarios[/:id@v]` (07 §API, зона A): пресеты из кода и библиотека человека для
 * редактора панели. Чтение — по токену чтения. Нечитаемая библиотека — 503 с причиной, а не
 * пустой список: «сценариев нет» и «не прочлось» человек должен различать (P44).
 *
 * `POST /v1/scenarios` (этап 9, F6): новый сценарий в библиотеку. Суд полномочий — класс
 * `save-scenario` (`human-strict`): число страницы + чистый пир или подпись устройства; пир
 * `unknown` без подписи — отказ, токен сессии — `forged-authority` (у модели дороги в библиотеку
 * нет, иначе она написала бы себе сценарий без проверок). Запись однократная: версия, под которой
 * уже лежит другой текст, — 409, перезаписи нет никогда; тот же текст — 200 (повтор после обрыва).
 */

export const SAVE_SCENARIO_ROUTE = 'POST /v1/scenarios';

/** Библиотека — в доме ядра; дом приходит средой ручек, а не выводится из каталога задач. */
function libraryDir(ctx: RouteContext): string {
  return ctx.env.layout.scenarios;
}

const REF = /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,8})$/;

export function registerScenarios(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/v1/scenarios', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const listing = await listLibrary(libraryDir(ctx));
    if ('unknown' in listing)
      return reply
        .code(503)
        .send(
          apiError('library-unreadable', `Библиотека сценариев не читается: ${listing.unknown}`),
        );
    const body: ScenariosReply = {
      presets: PRESETS,
      latestPresets: latestPresets().map((s) => ({ id: s.id, version: s.version })),
      library: listing.value.scenarios,
      problems: listing.value.problems,
    };
    return reply.send(body);
  });

  app.get<{ Params: { ref: string } }>('/v1/scenarios/:ref', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const match = REF.exec(request.params.ref);
    const ref = match
      ? scenarioRefSchema.safeParse({ id: match[1], version: Number(match[2]) })
      : null;
    if (!ref?.success)
      return reply.code(400).send(apiError('invalid-ref', 'Ожидается <id>@<версия>'));
    if (isPresetId(ref.data.id)) {
      const preset = presetOf(ref.data);
      return preset
        ? reply.send({ scenario: preset, source: 'preset' })
        : reply.code(404).send(apiError('not-found', 'Нет такой версии пресета'));
    }
    const read = await readLibraryScenario(libraryDir(ctx), ref.data);
    if (read.kind === 'value') return reply.send({ scenario: read.scenario, source: 'library' });
    if (read.kind === 'absent')
      return reply.code(404).send(apiError('not-found', 'Нет такого сценария в библиотеке'));
    if (read.kind === 'unknown')
      return reply
        .code(503)
        .send(apiError('library-unreadable', `Файл сценария не читается: ${read.reason}`));
    return reply
      .code(422)
      .send(apiError('invalid-scenario', `Файл сценария не по схеме: ${read.reason}`));
  });

  app.post('/v1/scenarios', async (request, reply) => {
    const token = ctx.tokenOf(request);
    if (token === 'none') {
      return reply.code(401).send(apiError('token-required', 'Нужен токен ядра'));
    }
    const parsed = saveScenarioBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(
        apiError('bad-scenario', 'Сценарий не прошёл разбор', {
          issues: commandIssues(parsed.error.issues, '', request.body),
        }),
      );
    }
    const body = parsed.data;
    // Суд — до чтения библиотеки: отказанный вызов не узнаёт даже, занята ли версия.
    const authority = decideAuthority(
      'save-scenario',
      await proofOfBody(request.raw, SAVE_SCENARIO_ROUTE, body, token, ctx.proof),
    );
    if (!authority.allow) {
      return reply
        .code(commandStatus(authority.code))
        .send(apiError(authority.code, authority.reason));
    }
    const { scenario } = body;
    const problems = scenarioProblems(scenario);
    if (problems.length > 0) {
      return reply
        .code(422)
        .send(apiError('invalid-scenario', 'Сценарий не годится', { problems }));
    }
    if (isPresetId(scenario.id)) {
      return reply.code(422).send(
        apiError('preset-id-reserved', `${scenario.id} — id встроенного пресета`, {
          problems: [`${scenario.id} is a built-in preset id; save under a new id`],
        }),
      );
    }
    const dir = libraryDir(ctx);
    const listing = await listLibrary(dir);
    if ('unknown' in listing) {
      return reply
        .code(503)
        .send(
          apiError('library-unreadable', `Библиотека сценариев не читается: ${listing.unknown}`),
        );
    }
    // Версии идут подряд: правка задачи (`edit-scenario`) ждёт «последняя + 1», дыра её сломала бы.
    const next = latestVersion(listing.value, scenario.id) + 1;
    if (scenario.version > next) {
      return reply.code(422).send(
        apiError('version-gap', `Следующая версия ${scenario.id} — ${next}`, {
          problems: [`${scenario.id} next version is ${next}, the body says ${scenario.version}`],
          next,
        }),
      );
    }
    const written = await writeLibraryScenario(dir, scenario);
    if ('refused' in written) {
      return reply
        .code(written.refused === 'version-taken' ? 409 : 422)
        .send(apiError(written.refused, written.reason, { next }));
    }
    const saved: ScenarioSaveReply = { ref: { id: scenario.id, version: scenario.version } };
    return reply.code(written.written === 'created' ? 201 : 200).send(saved);
  });
}
