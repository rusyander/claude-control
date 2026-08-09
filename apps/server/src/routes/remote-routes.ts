import type { FastifyInstance } from 'fastify';
import type {
  PushDevice,
  RemoteAccessSettings,
  RemoteAccessStatus,
} from '@claude-control/contracts';
import type { ServerContext } from '../context.ts';
import type { RunNotice } from '../domains/chat/ChatRunRegistry.ts';
import { readApiToken, rotateApiToken } from '../lib/api-token.ts';
import { detectTailscale } from '../lib/tailscale.ts';

/**
 * Разбор тела вручную, а не схемой из контрактов. Причина не в стиле: сервер
 * идёт под `node --experimental-strip-types`, и ЗНАЧЕНИЕ из бочки
 * `@claude-control/contracts` он взять не может — её реэкспорты без расширений
 * Node не резолвит, процесс падает при старте. Типы приходят оттуда, проверки
 * живут здесь.
 */
function parseSettings(body: unknown): Partial<RemoteAccessSettings> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Record<string, unknown>;
  const patch: Partial<RemoteAccessSettings> = {};

  if ('enabled' in raw) {
    if (typeof raw.enabled !== 'boolean') return undefined;
    patch.enabled = raw.enabled;
  }
  if ('notify' in raw) {
    if (typeof raw.notify !== 'boolean') return undefined;
    patch.notify = raw.notify;
  }
  if ('publicUrl' in raw) {
    if (typeof raw.publicUrl !== 'string') return undefined;
    patch.publicUrl = raw.publicUrl;
  }
  return patch;
}

/** Устройство: токен обязателен, площадка — из двух известных, остальное необязательно. */
function parseDevice(body: unknown): Omit<PushDevice, 'registeredAt'> | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Record<string, unknown>;
  if (typeof raw.token !== 'string' || !raw.token) return undefined;
  if (raw.platform !== 'android' && raw.platform !== 'ios') return undefined;
  return {
    token: raw.token,
    platform: raw.platform,
    label: typeof raw.label === 'string' ? raw.label : '',
  };
}

/**
 * Удалённый доступ: токен, адрес в приватной сети и телефоны для уведомлений.
 *
 * Токен отдаётся В ОТКРЫТУЮ — панель обязана его показать, иначе перенести его
 * в телефон нечем. Это не дыра: пока доступ выключен, до API дотягивается только
 * своя машина; когда включён, чтобы прочитать токен, нужно уже иметь токен.
 */
export function registerRemoteRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  notify: (notice: RunNotice) => void = () => {},
): void {
  const status = async (): Promise<RemoteAccessStatus> => {
    const settings = ctx.store.getSettings().remoteAccess;
    const tailscale = await detectTailscale();
    return {
      enabled: settings.enabled,
      publicUrl: settings.publicUrl,
      notify: settings.notify,
      token: readApiToken(),
      devices: ctx.store.getPushDevices(),
      detectedUrl: tailscale.url,
      serveActive: tailscale.serveActive,
    };
  };

  app.get('/api/remote', () => status());

  /**
   * Включить доступ или поправить адрес. Схема — та же, что у настроек, поэтому
   * «включено» из запроса не может оказаться строкой, а адрес — числом.
   */
  app.patch<{ Body: unknown }>('/api/remote', async (request, reply) => {
    const patch = parseSettings(request.body);
    if (!patch) return reply.code(400).send({ message: 'Настройки заданы неверно' });

    const current = ctx.store.getSettings().remoteAccess;
    ctx.store.updateSettings({ remoteAccess: { ...current, ...patch } });
    return status();
  });

  /**
   * Новый токен. Спаренные телефоны после этого перестают ходить — так и
   * задумано: это кнопка «я потерял телефон».
   */
  app.post('/api/remote/token', async () => {
    rotateApiToken();
    return status();
  });

  /** Приложение представилось: запомнить его push-токен. */
  app.post<{ Body: unknown }>('/api/remote/devices', async (request, reply) => {
    const device = parseDevice(request.body);
    if (!device) return reply.code(400).send({ message: 'Устройство описано неверно' });

    ctx.store.addPushDevice({ ...device, registeredAt: new Date().toISOString() });
    return status();
  });

  /**
   * Отвязать телефон. Токен приходит в теле, а не в пути: он содержит символы,
   * которые в сегменте адреса пришлось бы кодировать, и один забытый encode
   * молча отвязывал бы не то устройство.
   */
  app.delete<{ Body: { token?: string } }>('/api/remote/devices', async (request, reply) => {
    const token = request.body?.token;
    if (typeof token !== 'string' || !token) {
      return reply.code(400).send({ message: 'Не указан токен устройства' });
    }
    ctx.store.removePushDevice(token);
    return status();
  });

  /**
   * Проверочное уведомление. Нужно потому, что путь до телефона длинный (ключи
   * FCM, разрешение в системе, живой токен), и «не пришло» без такой кнопки
   * выясняется только через реальный прогон, то есть слишком поздно.
   */
  app.post('/api/remote/test', async () => {
    notify({ kind: 'done', chatId: 'test', projectPath: undefined });
    return { ok: true, devices: ctx.store.getPushDevices().length };
  });
}
