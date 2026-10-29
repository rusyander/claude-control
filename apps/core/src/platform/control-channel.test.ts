import { describe, expect, it } from 'vitest';
import { channelPath } from './control-channel.ts';

const LONG_TEMP = `/home/user/${'deep/'.repeat(20)}tmp`;

describe('F-60 control channel — never a predictable socket in the shared /tmp', () => {
  it('F-60 a socket dir too long for sun_path → refused with the reason, never /tmp/ad-sh-<id>.sock', () => {
    expect(() => channelPath('session-1', 'linux', LONG_TEMP)).toThrow(/sun_path/);
    expect(() => channelPath('session-1', 'darwin', LONG_TEMP)).toThrow(/sun_path/);
  });

  it('F-60 a private dir that fits → the socket lives in it; Windows → a named pipe', () => {
    expect(channelPath('session-1', 'linux', '/run/user/1000/agentdeck')).toBe(
      '/run/user/1000/agentdeck/ad-sh-session-1.sock',
    );
    expect(channelPath('session-1', 'win32', LONG_TEMP)).toBe(
      '\\\\.\\pipe\\agentdeck-sh-session-1',
    );
  });
});
