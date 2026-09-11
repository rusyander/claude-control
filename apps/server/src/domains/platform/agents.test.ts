import { describe, it, expect } from 'vitest';
import type { Platform } from '@agentdeck/contracts';
import { askAgent, readAgentSession, resetAgentSession } from './agents.ts';
import type { PlatformFetch } from './ca-fetch.ts';

/**
 * Агенты контура: исход обязан быть различим.
 *
 * Каждый случай здесь чинится своим способом — лицензия компании, ключ,
 * идентификатор агента, сторона контура, — и слипшееся «не получилось» не
 * чинится никак. Отдельно проверяется, что ключ не просачивается в причину: её
 * текст приходит от чужого сервера и оседает на экране.
 */

const BASE: Platform = {
  id: 'enterprise-platform-dev',
  title: 'EnterprisePlatform · dev',
  driver: 'enterprise-platform',
  baseUrl: 'https://api.dev.example.ru',
  enabled: true,
  mode: 'required',
  budgetUsd: 0,
  capabilities: [],
  targets: [],
  projectPaths: [],
  consumers: [],
  agents: [{ id: 'a1', title: 'Аналитик' }],
  budgetSince: '',
  toolShim: true,
  contourPrompt: true,
  caCertPath: '',
};

const TOKEN = 'sk-live-0123456789abcdef';
const AGENT = '4b0d1f5e-0000-4000-8000-000000000000';

/** Заглушка транспорта: запоминает запрос и отвечает заданным телом. */
function stub(
  body: string,
  init: { status?: number } = {},
): { fetchImpl: PlatformFetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: PlatformFetch = (url, requestInit) => {
    calls.push({ url: String(url), init: requestInit ?? {} });
    const status = init.status ?? 200;
    return Promise.resolve(
      // 204 обязан быть без тела — иначе конструктор Response не собирается.
      new Response(status === 204 ? null : body, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetchImpl, calls };
}

const ANSWER = JSON.stringify({
  id: 'run-1',
  object: 'chat.completion',
  agent: AGENT,
  choices: [
    { index: 0, message: { role: 'assistant', content: 'Готово.' }, finish_reason: 'stop' },
  ],
});

describe('askAgent: исходы различимы', () => {
  it('удача: текст, причина завершения и адрес агентской ручки', async () => {
    const { fetchImpl, calls } = stub(ANSWER);
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('ok');
    expect(answer.text).toBe('Готово.');
    expect(answer.finishReason).toBe('stop');
    expect(calls[0]?.url).toBe('https://api.dev.example.ru/v1/agent/completions');
  });

  it('тело содержит agent и не содержит model, stream и прочих привычек чата', async () => {
    const { fetchImpl, calls } = stub(ANSWER);
    await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body.agent).toBe(AGENT);
    // Контур отвергает эти поля четырёхсотым: настройки модели задаёт автор
    // агента. Прислать их — значит получить отказ вместо ответа.
    expect(Object.keys(body)).toEqual(['agent', 'messages']);
  });

  it('сессия едет полем session и возвращается вместе с признаком записи', async () => {
    const { fetchImpl, calls } = stub(
      JSON.stringify({ ...JSON.parse(ANSWER), session_recorded: false }),
    );
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      sessionId: 'ses-1',
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(JSON.parse(String(calls[0]?.init.body)).session).toBe('ses-1');
    expect(answer.sessionId).toBe('ses-1');
    // Ответ настоящий, а сессия не пополнилась: без этого признака человек
    // узнал бы о дыре только по «забывшему» агенту.
    expect(answer.sessionRecorded).toBe(false);
  });

  it('без сессии признака записи нет вовсе — своего мнения о чужом хранилище у панели нет', async () => {
    const { fetchImpl } = stub(ANSWER);
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.sessionRecorded).toBeUndefined();
  });

  it('нет лицензии agentbox: «недоступно», а не ошибка', async () => {
    const { fetchImpl } = stub(
      JSON.stringify({
        error: 'module_not_licensed',
        message: 'This module is not included in your current license.',
      }),
      { status: 403 },
    );
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('unavailable');
    expect(answer.detail).toContain('лицензию');
    // Ни слова про ключ и права: человек пошёл бы чинить то, что не ломалось.
    expect(answer.detail).not.toContain('403');
  });

  it('лицензия неактивна — тоже «недоступно», но причина своя', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: 'license_inactive' }), { status: 403 });
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('unavailable');
    expect(answer.detail).toContain('неактивна');
  });

  it('403 без кода лицензии — это про ключ, а не про модуль', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: { message: 'forbidden' } }), {
      status: 403,
    });
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('unauthorized');
  });

  it('нет такого агента: 404 называет, где взять идентификатор', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: { message: 'agent not found' } }), {
      status: 404,
    });
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('rejected');
    expect(answer.detail).toContain('админке');
  });

  it('объявленное автором завершение с ошибкой — свой исход, а не сбой', async () => {
    const { fetchImpl } = stub(
      JSON.stringify({ error: { message: 'нет данных за период', type: 'agent_error' } }),
      { status: 422 },
    );
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('agent-error');
    expect(answer.detail).toContain('нет данных за период');
  });

  it('5xx — сторона контура, а не запрос человека', async () => {
    const { fetchImpl } = stub('', { status: 502 });
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('not-ready');
  });

  it('502 не повторяется: прогон агента мог состояться и стоить денег', async () => {
    let calls = 0;
    const fetchImpl: PlatformFetch = () => {
      calls += 1;
      return Promise.resolve(new Response('', { status: 502 }));
    };
    await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(calls).toBe(1);
  });

  it('ключ, отражённый контуром в тексте ошибки, наружу не уходит', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: { message: `unknown api key ${TOKEN}` } }), {
      status: 400,
    });
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it('нет связи — исход failed с русской причиной, а не исключение', async () => {
    const fetchImpl: PlatformFetch = () => Promise.reject(new Error('getaddrinfo ENOTFOUND'));
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('failed');
    expect(answer.detail).toContain('Нет связи');
  });

  it('последним сообщением обязан быть вопрос человека — отказ без похода по сети', async () => {
    let called = false;
    const fetchImpl: PlatformFetch = () => {
      called = true;
      return Promise.resolve(new Response(ANSWER));
    };
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'assistant', content: 'уже ответил' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('rejected');
    expect(called).toBe(false);
  });

  it('с сессией системное сообщение отвергается: контур его не хранит', async () => {
    const { fetchImpl, calls } = stub(ANSWER);
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      sessionId: 'ses-1',
      messages: [
        { role: 'system', content: 'отвечай коротко' },
        { role: 'user', content: 'Привет' },
      ],
      fetchImpl,
    });

    expect(answer.outcome).toBe('rejected');
    expect(calls).toHaveLength(0);
  });

  it('без сессии системное сообщение проходит: оно живёт один прогон', async () => {
    const { fetchImpl, calls } = stub(ANSWER);
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [
        { role: 'system', content: 'отвечай коротко' },
        { role: 'user', content: 'Привет' },
      ],
      fetchImpl,
    });

    expect(answer.outcome).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('ответ в неузнанной форме — промах разбора, а не пустой ответ агента', async () => {
    // Своей формы в теле нет вовсе (так отвечает изменившийся контур). Выдать
    // это за «агент ответил пусто» значит отправить человека к автору агента
    // чинить сломанное здесь.
    const { fetchImpl } = stub(JSON.stringify({ output: 'Готово.' }));
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('failed');
    expect(answer.detail).toContain('не узнала');
  });

  it('пустой ответ агента — это удача с оговоркой, а не сбой', async () => {
    const { fetchImpl } = stub(
      JSON.stringify({ choices: [{ index: 0, message: { content: '' } }] }),
    );
    const answer = await askAgent({
      platform: BASE,
      token: TOKEN,
      agentId: AGENT,
      messages: [{ role: 'user', content: 'Привет' }],
      fetchImpl,
    });

    expect(answer.outcome).toBe('ok');
    expect(answer.detail).toContain('пустым');
  });
});

describe('сессии агента', () => {
  const SESSION = JSON.stringify({
    sessions: [
      {
        agent_id: AGENT,
        messages: [
          { role: 'user', content: 'Привет' },
          { role: 'assistant', content: 'Готово.' },
          { role: 'tool', content: 'служебное' },
        ],
      },
    ],
  });

  it('переписка приходит от контура, а роли вне словаря отбрасываются', async () => {
    const { fetchImpl, calls } = stub(SESSION);
    const result = await readAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      agentId: AGENT,
      fetchImpl,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.messages).toHaveLength(2);
    expect(result.agentIds).toEqual([AGENT]);
    expect(result.empty).toBe(false);
    expect(calls[0]?.url).toContain(`agent/sessions/ses-1?agent=${AGENT}`);
  });

  it('пустая сессия — это «пусто», а не отказ', async () => {
    const { fetchImpl } = stub(JSON.stringify({ sessions: [] }));
    const result = await readAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.empty).toBe(true);
  });

  it('сброс идёт методом DELETE и молчит об успехе', async () => {
    const { fetchImpl, calls } = stub('', { status: 204 });
    const result = await resetAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.init.method).toBe('DELETE');
  });

  it('число реплик — контура, а не длина показываемого списка', async () => {
    const { fetchImpl } = stub(SESSION);
    const result = await readAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    // Инструментный ход панель не рисует, но в памяти контура он есть: занизив
    // счёт, панель объявила бы «контур помнит 2» там, где он помнит 3.
    expect(result.total).toBe(3);
    expect(result.messages).toHaveLength(2);
  });

  it('сессия из одних инструментных ходов не объявляется пустой', async () => {
    const { fetchImpl } = stub(
      JSON.stringify({
        sessions: [{ agent_id: AGENT, messages: [{ role: 'tool', content: 'x' }] }],
      }),
    );
    const result = await readAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.empty).toBe(false);
    expect(result.total).toBe(1);
  });

  it('404 на чтении — «контур такой сессии не помнит», а не отказ', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: { message: 'session not found' } }), {
      status: 404,
    });
    const result = await readAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect('error' in result).toBe(false);
    if ('error' in result) return;
    expect(result.empty).toBe(true);
    // Текст про «проверьте идентификатор агента в админке» здесь соврал бы: 404
    // на этом маршруте — про сессию.
    expect(result.total).toBe(0);
  });

  it('404 на сбросе — обещанная идемпотентность: стирать было нечего', async () => {
    const { fetchImpl } = stub('', { status: 404 });
    const result = await resetAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
  });

  it('422 сессии говорит про идентификатор сессии, а не про завершение агента', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: { message: 'invalid uuid' } }), {
      status: 422,
    });
    const result = await resetAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'не-uuid',
      fetchImpl,
    });

    expect('error' in result).toBe(true);
    if (!('error' in result)) return;
    expect(result.error).toContain('сессии');
    expect(result.error).not.toContain('Агент завершился');
  });

  it('сброс сужается тем же агентом: сессию могут делить несколько', async () => {
    const { fetchImpl, calls } = stub('', { status: 204 });
    await resetAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      agentId: AGENT,
      fetchImpl,
    });

    // Без этого параметра сброс стёр бы ветки агентов, о которых человек не
    // просил.
    expect(calls[0]?.url).toContain(`?agent=${AGENT}`);
  });

  it('отказ сессии приезжает причиной, а не исключением', async () => {
    const { fetchImpl } = stub(JSON.stringify({ error: 'module_not_licensed' }), { status: 403 });
    const result = await resetAgentSession({
      platform: BASE,
      token: TOKEN,
      sessionId: 'ses-1',
      fetchImpl,
    });

    expect('error' in result).toBe(true);
  });
});
