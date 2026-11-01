import type { FastifyInstance } from 'fastify';
import type { ProfileReply } from '@agentdeck/contracts/core/panel-api';
import type { Profile } from '@agentdeck/contracts/core/records';
import { readTextFact } from '../platform/safe-io/files.ts';
import { profilePath } from '../verifier/profile/index.ts';
import { profileSchema } from '../verifier/profile/schema.ts';
import { apiError } from './errors.ts';
import type { RouteContext } from './route-context.types.ts';

/**
 * `GET /v1/profiles/:repoKey` (07:3-16, 04:45-52, F7) — сохранённый профиль репозитория из дома
 * ядра (`profiles/<hash repoKey>.json`). Только чтение: обнаружение заново пишет файл
 * (`profileOf`), а чтение панели не вправе ни писать, ни ходить в репозиторий. Файл, чей
 * `repoKey` не тот, что спрошен, — не этот профиль (404, а не чужие данные под этим именем);
 * не прочитался или не прошёл схему — 500 с причиной, а не «профиля нет» (P44).
 */

const REPO_KEY_MAX = 4096;

export function registerProfiles(app: FastifyInstance, ctx: RouteContext): void {
  app.get<{ Params: { repoKey: string } }>('/v1/profiles/:repoKey', async (request, reply) => {
    if (!ctx.requireRead(request, reply)) return reply;
    const { repoKey } = request.params;
    if (!repoKey || repoKey.length > REPO_KEY_MAX) {
      return reply
        .code(400)
        .send(apiError('bad-repo-key', 'Ключ репозитория пуст или слишком длинный'));
    }
    const text = await readTextFact(profilePath(ctx.env.layout.profiles, repoKey));
    if ('absent' in text) {
      return reply.code(404).send(apiError('no-profile', 'Профиля репозитория ещё нет'));
    }
    if ('unknown' in text) {
      return reply.code(500).send(apiError('profile-unreadable', text.unknown));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text.value);
    } catch {
      raw = undefined;
    }
    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) {
      return reply.code(500).send(apiError('profile-unreadable', 'Файл профиля не прошёл схему'));
    }
    const profile = parsed.data as Profile;
    if (profile.repoKey !== repoKey) {
      return reply
        .code(404)
        .send(apiError('no-profile', 'Файл профиля принадлежит другому репозиторию'));
    }
    const body: ProfileReply = { repoKey, profile };
    return body;
  });
}
