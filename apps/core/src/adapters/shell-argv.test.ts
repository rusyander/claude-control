import { describe, expect, it } from 'vitest';
import { commandArgv } from './shell-argv.ts';
import { SDK_PERMIT_CODEC } from './sdk-stream/permit-codec.ts';

describe('commandArgv — argv of the first simple command (P04: decisions by argv, never text)', () => {
  it.each([
    ['git push origin main', ['git', 'push', 'origin', 'main']],
    ['  git\tpush  ', ['git', 'push']],
    ['\'git\' "push" \'a b\' "c d"', ['git', 'push', 'a b', 'c d']],
    ['echo "a \\"q\\" \\\\ \\$x \\`y\\` \\n"', ['echo', 'a "q" \\ $x `y` \\n']],
    ["echo 'no \\escape'", ['echo', 'no \\escape']],
    ['echo a\\ b \\"c', ['echo', 'a b', '"c']],
    ['C:\\tools\\git.exe push', ['C:\\tools\\git.exe', 'push']],
    ['A=1 B=two git push', ['git', 'push']],
    ['git push; rm -rf x', ['git', 'push']],
    ['git push && echo ok', ['git', 'push']],
    ['git push | tee log', ['git', 'push']],
    ['git push\nnext', ['git', 'push']],
    ['echo ";" done', ['echo', ';', 'done']],
    ["echo '' x", ['echo', '', 'x']],
    ['echo trailing\\', ['echo', 'trailing\\']],
    ['A=1', []],
    ['', []],
  ])('%j → %j', (command, argv) => {
    expect(commandArgv(command)).toEqual(argv);
  });
});

describe('SDK permit codec — one shape for the permit tool and the in-band can_use_tool', () => {
  it('reads tool, input and tool use id; refuses a question without a call id or with a bad shape', () => {
    expect(
      SDK_PERMIT_CODEC.read({ tool_name: 'Bash', input: { command: 'ls' }, tool_use_id: 't1' }),
    ).toEqual({ toolUseId: 't1', call: { tool: 'Bash', input: { command: 'ls' } } });
    expect(SDK_PERMIT_CODEC.read({ tool_name: 'Bash', tool_use_id: 't1' })).toEqual({
      toolUseId: 't1',
      call: { tool: 'Bash', input: {} },
    });
    for (const bad of [
      null,
      [],
      'x',
      { tool_name: 'Bash', input: {} },
      { tool_name: '', tool_use_id: 't' },
      { tool_name: 'Bash', tool_use_id: '' },
      { tool_name: 'Bash', tool_use_id: 't', input: [] },
      { tool_name: 'Bash', tool_use_id: 't', input: 'x' },
    ]) {
      expect(SDK_PERMIT_CODEC.read(bad)).toBeUndefined();
    }
  });

  it('renders allow with the (possibly updated) input and deny with the reason', () => {
    expect(SDK_PERMIT_CODEC.render({ allow: true, input: { a: 1 } })).toEqual({
      behavior: 'allow',
      updatedInput: { a: 1 },
    });
    expect(SDK_PERMIT_CODEC.render({ allow: false, message: 'no' })).toEqual({
      behavior: 'deny',
      message: 'no',
    });
  });
});
