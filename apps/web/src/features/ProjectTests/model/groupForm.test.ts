import { describe, it, expect } from 'vitest';
import type { ProjectTestGroup } from '@agentdeck/contracts';
import { groupFormSeed, takenGroup } from './groupForm';

describe('takenGroup', () => {
  const groups: ProjectTestGroup[] = [
    { id: 'chat', title: 'Чат', file: 'chat.tests.json', cases: [] },
    { id: 'api', title: 'API', file: 'api.tests.json', cases: [] },
  ];

  // Живая проверка 26.09: «Новая группа» → «chat» закрывала окно молча — сервер
  // отдаёт существующую группу, и человек думал, что завёл новую.
  it('занятый идентификатор возвращает группу, которая его носит', () => {
    expect(takenGroup(groups, 'chat')?.title).toBe('Чат');
    expect(takenGroup(groups, ' CHAT ')?.title).toBe('Чат');
  });

  it('свободный идентификатор свободен', () => {
    expect(takenGroup(groups, 'smoke')).toBeUndefined();
    expect(takenGroup([], 'chat')).toBeUndefined();
  });
});

/**
 * Окно группы заполняется заново только при открытии и при смене группы. Во
 * время прогона вид перечитывается каждые 2 с и приносит НОВЫЙ объект той же
 * группы (статусы кейсов сменились) — перезаполнение по нему стирало название,
 * которое человек как раз набирал.
 */
describe('groupFormSeed', () => {
  const polled = (status: 'failed' | 'passed'): ProjectTestGroup => ({
    id: 'chat',
    title: 'Чат',
    file: 'chat.tests.json',
    cases: [{ id: 'c1', type: 'case', title: 'Кейс', steps: [], status, source: 'agent' }],
  });

  it('новый объект той же группы — та же затравка: набранное не стирается', () => {
    expect(groupFormSeed(true, polled('failed'))).toBe(groupFormSeed(true, polled('passed')));
  });

  it('другая группа, новая группа и повторное открытие — затравка другая', () => {
    const edit = groupFormSeed(true, polled('failed'));
    expect(groupFormSeed(true, { ...polled('failed'), id: 'api' })).not.toBe(edit);
    expect(groupFormSeed(true, undefined)).not.toBe(edit);
    expect(groupFormSeed(false, polled('failed'))).toBeUndefined();
  });
});
