import { describe, expect, it } from 'vitest';
import { projectFilePath } from './projectFilePath';

describe('projectFilePath', () => {
  it('keeps the Windows separator of the root', () => {
    expect(projectFilePath('C:\\work\\shop', '.claude', 'settings.json')).toBe(
      'C:\\work\\shop\\.claude\\settings.json',
    );
  });

  it('keeps forward slashes, including a Windows drive written with them', () => {
    expect(projectFilePath('C:/work/shop', '.mcp.json')).toBe('C:/work/shop/.mcp.json');
    expect(projectFilePath('/home/u/shop', '.mcp.json')).toBe('/home/u/shop/.mcp.json');
  });

  it('does not double a trailing separator', () => {
    expect(projectFilePath('C:\\work\\shop\\', '.mcp.json')).toBe('C:\\work\\shop\\.mcp.json');
    expect(projectFilePath('/home/u/shop/', '.claude')).toBe('/home/u/shop/.claude');
  });
});
