import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SECRET_MASK } from '../../../lib/secret-mask/secret-mask.ts';
import { maskDeep } from '../action-kit/action-kit.ts';
import { maskResult, netMessage, netPreview, netResult } from './result-net.ts';

/**
 * Сетка перед моделью (D8) и маска действий `maskDeep` — одно правило об именах.
 * Каждое правило проверяется в обе стороны: секрет спрятан И несекретное видно —
 * маска, прячущая всё, так же бесполезна модели, как маска, не прячущая ничего.
 */
const VENDOR_KEY = 'sk-ant-api03-Q7xW2mZ9kL4pR8tY1vB6nC3';
const PLAIN = 'hunter22';
const OPAQUE = 'Zx9kLmN0pQrS7tUvWxYz12345';

/** Настоящий каталог на диске: сетка прощает только сегмент пути, который существует. */
let root = '';
beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-net-')));
  mkdirSync(join(root, 'cc-agent-a4-project-Op03Ck', 'src'), { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe.each([
  ['net (maskResult)', (value: unknown) => maskResult(value)],
  ['maskDeep', (value: unknown) => maskDeep(value)],
])('%s: a bare `key` is a label', (_name, mask) => {
  it('a schema field key and an issue key stay visible', () => {
    const fields = [
      { key: 'environment', title: 'Environment', type: 'select' },
      { key: 'PRJ-142', summary: 'Login fails' },
    ];
    expect(mask(fields)).toEqual(fields);
  });

  it('a real secret under a bare `key` is still hidden by its shape', () => {
    expect(mask({ key: VENDOR_KEY })).toEqual({ key: SECRET_MASK });
  });

  it('an entry labelled with a secret name hides its value, whatever its shape', () => {
    expect(mask({ key: 'API_TOKEN', value: PLAIN })).toEqual({
      key: 'API_TOKEN',
      value: SECRET_MASK,
    });
    expect(mask({ name: 'DB_PASSWORD', value: PLAIN })).toEqual({
      name: 'DB_PASSWORD',
      value: SECRET_MASK,
    });
    expect(mask({ key: 'REGION', value: 'eu-west' })).toEqual({ key: 'REGION', value: 'eu-west' });
  });

  it('secret field names still hide plain values; references stay', () => {
    expect(mask({ token: PLAIN, password: '${DB_PASSWORD}' })).toEqual({
      token: SECRET_MASK,
      password: '${DB_PASSWORD}',
    });
  });
});

describe('net only: identifiers, paths, argument lists, app texts', () => {
  it('camelCase …Key identifiers stay, secret …Key names hide', () => {
    expect(
      maskResult({
        chatKey: 'chat-7',
        jiraIssueKey: 'PRJ-1',
        apiKey: PLAIN,
        sessionTokenKey: PLAIN,
      }),
    ).toEqual({
      chatKey: 'chat-7',
      jiraIssueKey: 'PRJ-1',
      apiKey: SECRET_MASK,
      sessionTokenKey: SECRET_MASK,
    });
  });

  it('path fields pass as they are; the same string elsewhere is checked', () => {
    const dir = 'C:/tmp/cc-agent-a4-project-uy9Xe7Qk2Lm4Np8Rw3';
    expect(maskResult({ projectPath: dir, cwd: dir })).toEqual({ projectPath: dir, cwd: dir });
    expect(maskResult({ note: `key ${VENDOR_KEY}` })).toEqual({ note: `key ${SECRET_MASK}` });
  });

  it('a segment of a path on disk stays; a URL segment and a flag value are still checked', () => {
    // Сегмент mkdtemp, который детектор по форме принимает за ключ (полный прогон 28.09).
    const project = join(root, 'cc-agent-a4-project-Op03Ck');
    const card = { summary: 'Start', fields: [{ label: 'Проект', value: `Демо — ${project}` }] };
    expect(netPreview(card)).toEqual(card);
    expect(netMessage(`File ${project}/src/app.ts not found`)).toBe(
      `File ${project}/src/app.ts not found`,
    );
    const slashed = `${project.replace(/\\/g, '/')}/x`;
    expect(maskResult({ note: slashed })).toEqual({ note: slashed });
    expect(maskResult({ note: `https://hooks.example.com/services/${OPAQUE}` })).toEqual({
      note: `https://hooks.example.com/services/${SECRET_MASK}`,
    });
    expect(netMessage(`${project}\\cli.exe --token ${PLAIN}`)).toBe(
      `${project}\\cli.exe --token ${SECRET_MASK}`,
    );
    expect(netMessage(`pasted ${OPAQUE} here`)).toBe(`pasted ${SECRET_MASK} here`);
  });

  // Ревью U0, m1 (28.09.2026): исключение «сегмент пути» действовало на любой токен, похожий
  // на путь, — ключ в строке вида `C:\x\<ключ>` проходил сетку.
  it('a path-shaped token that is not on disk is checked like any other text', () => {
    const fake = `C:\\nowhere-${OPAQUE}\\${OPAQUE}\\x.txt`;
    expect(netMessage(`File ${fake} not found`)).not.toContain(OPAQUE);
    expect(maskResult({ note: `/nowhere/${OPAQUE}/x` })).toEqual({
      note: `/nowhere/${SECRET_MASK}/x`,
    });
  });

  it('a vendor key or a JWT is never exempt, even as a segment of a real folder', () => {
    const keyed = join(root, VENDOR_KEY);
    mkdirSync(keyed, { recursive: true });
    expect(netMessage(`Saved to ${keyed}\\a.txt`)).toBe(
      `Saved to ${join(root, SECRET_MASK)}\\a.txt`,
    );
    expect(maskResult({ note: `${keyed.replace(/\\/g, '/')}/a.txt` })).toEqual({
      note: `${join(root, SECRET_MASK).replace(/\\/g, '/')}/a.txt`,
    });
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTYifQ', 'c2lnbmF0dXJlMTIz'].join('.');
    expect(netMessage(`${root}\\${jwt}\\x`)).toBe(`${root}\\${SECRET_MASK}\\x`);
  });

  it('an argument list hides the value after a secret flag', () => {
    expect(maskResult({ args: ['server.js', '--api-key', PLAIN, '--port', '80'] })).toEqual({
      args: ['server.js', '--api-key', SECRET_MASK, '--port', '80'],
    });
  });

  it('help texts are exempt; every other action goes through the net', () => {
    const example = { text: 'Set KEY=VALUE in .env' };
    expect(netResult('read_help_topic', example)).toBe(example);
    expect(netResult('list_env', { value: `Bearer ${PLAIN}` })).toEqual({
      value: `Bearer ${SECRET_MASK}`,
    });
    expect(netMessage(`upstream said: token=${PLAIN}`)).toBe(`upstream said: token=${SECRET_MASK}`);
  });
});
