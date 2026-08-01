import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@shared/api/client', () => ({
  apiClient: {
    defaults: { baseURL: '/api' },
    get: vi.fn(async () => ({ data: '' })),
    post: vi.fn(async () => ({ data: {} })),
  },
}));

import { apiClient } from '@shared/api/client';
import type { EnvVar } from '@claude-control/contracts';
import { buildEnvDraft } from './EnvFormModal.lib';

/**
 * Правка секрета не должна стирать его значение.
 *
 * Регрессия, ради которой тест и написан: поле значения у секрета открывается
 * пустым, подсказка обещает «оставьте пустым, если менять не нужно», а форма
 * отправляла эту пустоту как есть — сервер писал `GITLAB_TOKEN=` поверх
 * строки в .mcp-secrets.env, и токен пропадал молча, с видом успеха.
 */

const secret: EnvVar = {
  id: 'secrets:GITLAB_TOKEN',
  key: 'GITLAB_TOKEN',
  value: 'glp•••••••ab',
  isSecret: true,
  source: 'secrets',
};

const get = vi.mocked(apiClient.get);

beforeEach(() => {
  get.mockReset();
});

describe('buildEnvDraft', () => {
  it('нетронутое поле секрета сохраняет старое значение', async () => {
    get.mockResolvedValue({ data: 'glpat-real-token' } as never);

    const draft = await buildEnvDraft(
      { key: 'GITLAB_TOKEN', value: '', source: 'secrets', comment: 'токен GitLab' },
      secret,
    );

    expect(draft.value).toBe('glpat-real-token');
    expect(draft.comment).toBe('токен GitLab');
    expect(get).toHaveBeenCalledWith(
      '/env/reveal',
      expect.objectContaining({ params: { key: 'GITLAB_TOKEN', source: 'secrets' } }),
    );
  });

  it('значение дочитывается сырым текстом, без разбора JSON', async () => {
    // Иначе чисто числовой секрет приезжал бы числом, а `{"a":1}` — объектом,
    // и проверка «не дочитали» отвергала бы законное значение.
    get.mockResolvedValue({ data: '12345' } as never);

    const draft = await buildEnvDraft(
      { key: 'GITLAB_TOKEN', value: '', source: 'secrets', comment: '' },
      secret,
    );

    expect(draft.value).toBe('12345');
    const config = get.mock.calls[0]?.[1] as { transformResponse?: unknown[] } | undefined;
    expect(config?.transformResponse).toHaveLength(1);
  });

  it('переименование секрета переносит значение, дочитывая его по старому ключу', async () => {
    get.mockResolvedValue({ data: 'glpat-real-token' } as never);

    const draft = await buildEnvDraft(
      { key: 'GITLAB_PAT', value: '', source: 'settings', comment: '' },
      secret,
    );

    expect(draft).toEqual({
      key: 'GITLAB_PAT',
      value: 'glpat-real-token',
      source: 'settings',
      isSecret: true,
      // Пустое поле уезжает строкой, а не undefined: сервер по этому и отличает
      // «комментарий стёрли» от «поля не присылали» (см. следующий тест).
      comment: '',
    });
    expect(get).toHaveBeenCalledWith(
      '/env/reveal',
      expect.objectContaining({ params: { key: 'GITLAB_TOKEN', source: 'secrets' } }),
    );
  });

  it('не дочитали значение — падаем, а не отправляем пустоту', async () => {
    get.mockResolvedValue({ data: '' } as never);

    await expect(
      buildEnvDraft({ key: 'GITLAB_TOKEN', value: '', source: 'secrets', comment: '' }, secret),
    ).rejects.toThrow('GITLAB_TOKEN');
  });

  it('введённое значение секрета уходит как есть, без лишнего запроса', async () => {
    const draft = await buildEnvDraft(
      { key: ' GITLAB_TOKEN ', value: 'glpat-new', source: 'secrets', comment: '' },
      secret,
    );

    expect(draft.key).toBe('GITLAB_TOKEN');
    expect(draft.value).toBe('glpat-new');
    expect(get).not.toHaveBeenCalled();
  });

  it('открытую переменную по-прежнему можно очистить', async () => {
    const plain: EnvVar = {
      id: 'settings:NODE_ENV',
      key: 'NODE_ENV',
      value: 'production',
      isSecret: false,
      source: 'settings',
    };

    const draft = await buildEnvDraft(
      { key: 'NODE_ENV', value: '', source: 'settings', comment: '' },
      plain,
    );

    expect(draft.value).toBe('');
    expect(draft.isSecret).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it('новая переменная не ходит за старым значением', async () => {
    const draft = await buildEnvDraft({
      key: 'API_URL',
      value: 'https://example.com',
      source: 'settings',
      comment: '',
    });

    expect(draft.value).toBe('https://example.com');
    expect(get).not.toHaveBeenCalled();
  });

  it('стёртый комментарий уходит пустой строкой, а не пропадает (#52)', async () => {
    // С `|| undefined` сервер считал бы, что поле не присылали, и оставлял бы
    // старый комментарий в .mcp-secrets.env — при ответе «сохранено».
    const draft = await buildEnvDraft(
      { key: 'NODE_ENV', value: 'production', source: 'settings', comment: '   ' },
      {
        id: 'settings:NODE_ENV',
        key: 'NODE_ENV',
        value: 'production',
        isSecret: false,
        source: 'settings',
        comment: 'старый комментарий',
      },
    );

    expect(draft.comment).toBe('');
  });
});
