import { describe, expect, it } from 'vitest';
import { CATALOG_PROVIDERS } from '../../../providers/catalog.ts';
import {
  SUPERVISOR_COMMON_FIELDS,
  SUPERVISOR_EVENTS,
  buildSupervisorPayload,
  encodeSupervisorPayload,
  hookEventOwner,
  payloadFieldsOfEvent,
  supervisorOwnedEvents,
  type SupervisorEvent,
  type SupervisorRun,
} from './payload.ts';

const RUN: SupervisorRun = {
  providerId: 'codex',
  sessionId: 'chat-1',
  cwd: 'C:/work/demo',
  transcriptPath: 'C:/appdata/provider-chats/codex/chat-1.jsonl',
};

describe('нагрузка события: общие поля', () => {
  it('каждое событие несёт все четыре общих поля, заполненных описанием прогона', () => {
    for (const event of SUPERVISOR_EVENTS) {
      const payload = buildSupervisorPayload(RUN, { event });

      expect(payload.hook_event_name, event).toBe(event);
      expect(payload.session_id, event).toBe('chat-1');
      expect(payload.cwd, event).toBe('C:/work/demo');
      expect(payload.transcript_path, event).toBe('C:/appdata/provider-chats/codex/chat-1.jsonl');
    }
  });
});

describe('нагрузка события: «нет данных» не равно «данные пустые»', () => {
  it('поле, которое заполнить нечем, отсутствует, а не содержит пустую строку', () => {
    const payload = buildSupervisorPayload(RUN, { event: 'UserPromptSubmit' });

    expect('prompt' in payload).toBe(false);
    // Именно это отличие и покупается: скрипт, пишущий `payload.prompt ?? ''`,
    // обязан иметь возможность узнать, что запроса не было вовсе.
    expect(payload.prompt).toBeUndefined();
  });

  it('пустая строка — это данные, и она доезжает до скрипта', () => {
    const payload = buildSupervisorPayload(RUN, { event: 'UserPromptSubmit', prompt: '' });

    expect('prompt' in payload).toBe(true);
    expect(payload.prompt).toBe('');
  });

  it('ложь в булевом поле — тоже данные и не выпадает как пустое значение', () => {
    const payload = buildSupervisorPayload(RUN, { event: 'Stop', stopHookActive: false });

    expect('stop_hook_active' in payload).toBe(true);
    expect(payload.stop_hook_active).toBe(false);
  });
});

describe('нагрузка события: набор полей зафиксирован', () => {
  /**
   * Таблица — ожидание теста, а не пересказ кода: сюда переписан справочник
   * Claude. Разойдётся объявление в `payload.ts` с этой таблицей — красное здесь.
   */
  const EXPECTED: Record<SupervisorEvent, readonly string[]> = {
    SessionStart: ['source'],
    UserPromptSubmit: ['prompt'],
    Stop: ['stop_hook_active'],
    SubagentStop: ['stop_hook_active'],
    Notification: ['message'],
    SessionEnd: ['reason'],
    PreCompact: ['trigger', 'custom_instructions'],
  };

  it('у каждого события ровно свои поля сверх общих четырёх', () => {
    for (const event of SUPERVISOR_EVENTS) {
      expect(payloadFieldsOfEvent(event), event).toEqual([
        ...SUPERVISOR_COMMON_FIELDS,
        ...EXPECTED[event],
      ]);
    }
  });

  it('поле чужого события в нагрузку не проталкивается', () => {
    // Вызывающий передал `prompt` в `SessionStart`. У Claude такого поля у этого
    // события не бывает — значит его не должно быть и здесь, иначе скрипт
    // поведёт себя не так, как повёл бы у Claude.
    const payload = buildSupervisorPayload(RUN, {
      event: 'SessionStart',
      source: 'startup',
      prompt: 'текст',
    });

    expect('prompt' in payload).toBe(false);
    expect(payload.source).toBe('startup');
  });

  it('заполненная нагрузка каждого события состоит только из объявленных полей', () => {
    const full = {
      SessionStart: { source: 'startup' },
      UserPromptSubmit: { prompt: 'привет' },
      Stop: { stopHookActive: true },
      SubagentStop: { stopHookActive: true },
      Notification: { message: 'нужно решение' },
      SessionEnd: { reason: 'clear' },
      PreCompact: { trigger: 'manual', customInstructions: 'сохрани пути' },
    } as const;

    for (const event of SUPERVISOR_EVENTS) {
      const payload = buildSupervisorPayload(RUN, { event, ...full[event] });
      expect(Object.keys(payload).sort(), event).toEqual([...payloadFieldsOfEvent(event)].sort());
    }
  });
});

describe('владелец события — ровно один', () => {
  it('каждое событие у каждой цели принадлежит либо CLI, либо надзирателю', () => {
    for (const provider of CATALOG_PROVIDERS) {
      for (const event of SUPERVISOR_EVENTS) {
        const owner = hookEventOwner(provider, event);
        expect(['native', 'supervisor'], `${provider.id}/${event}`).toContain(owner);

        const supervised = supervisorOwnedEvents(provider).includes(event);
        // Два утверждения об одном событии обязаны совпадать: список для отчёта
        // и решение для прогона — один факт, а не два.
        expect(supervised, `${provider.id}/${event}`).toBe(owner === 'supervisor');
      }
    }
  });

  it('событие, которое цель умеет сама, надзиратель не дублирует', () => {
    const withOwnHooks = CATALOG_PROVIDERS.filter((provider) =>
      (provider.hooksConfig?.events ?? []).some((name) =>
        (SUPERVISOR_EVENTS as readonly string[]).includes(name),
      ),
    );

    // Если каталог перестанет содержать такую цель, проверка обессмыслится
    // молча — поэтому её наличие утверждается отдельно.
    expect(withOwnHooks.length).toBeGreaterThan(0);

    for (const provider of withOwnHooks) {
      for (const name of provider.hooksConfig?.events ?? []) {
        if (!(SUPERVISOR_EVENTS as readonly string[]).includes(name)) continue;
        expect(hookEventOwner(provider, name as SupervisorEvent), `${provider.id}/${name}`).toBe(
          'native',
        );
      }
    }
  });

  it('у цели без своего механизма хуков надзиратель отыгрывает всё', () => {
    const bare = CATALOG_PROVIDERS.find(
      (provider) => !provider.hooksConfig && !provider.nativeMechanisms?.hookEvents,
    );
    expect(bare, 'в каталоге нет цели без механизма хуков').toBeDefined();
    if (!bare) return;

    expect(supervisorOwnedEvents(bare)).toEqual([...SUPERVISOR_EVENTS]);
  });
});

describe('усыновлённый прогон после перезапуска панели', () => {
  it('описание прогона переживает сериализацию и даёт ту же нагрузку', () => {
    // Панель сняли посреди прогона: описание восстанавливается из состояния на
    // диске, то есть через JSON. Если бы в нём жил дескриптор процесса или
    // замыкание, события конца после перезапуска собрать было бы нечем — они
    // потерялись бы молча.
    const restored = JSON.parse(JSON.stringify(RUN)) as SupervisorRun;

    for (const event of SUPERVISOR_EVENTS) {
      expect(buildSupervisorPayload(restored, { event }), event).toEqual(
        buildSupervisorPayload(RUN, { event }),
      );
    }
  });
});

describe('сериализация для stdin', () => {
  it('нагрузка уходит одной строкой JSON, разбираемой обратно без потерь', () => {
    const encoded = encodeSupervisorPayload(RUN, {
      event: 'UserPromptSubmit',
      prompt: 'путь "C:\\work" и перевод\nстроки',
    });

    expect(encoded).not.toContain('\n');
    expect(JSON.parse(encoded)).toEqual(
      buildSupervisorPayload(RUN, {
        event: 'UserPromptSubmit',
        prompt: 'путь "C:\\work" и перевод\nстроки',
      }),
    );
  });
});
