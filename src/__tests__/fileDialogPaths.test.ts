import { describe, expect, it } from 'vitest';
import {
  getDialogDefaultPath,
  getParentDirectory,
  normalizeFileDialogDirs,
} from '../lib/fileDialogPaths';

describe('fileDialogPaths', () => {
  it('remembers the parent directory for Windows and Unix file paths', () => {
    expect(getParentDirectory('D:\\Workspace\\scripts\\tool.lua')).toBe('D:\\Workspace\\scripts');
    expect(getParentDirectory('/home/me/scripts/tool.lua')).toBe('/home/me/scripts');
  });

  it('builds save default paths from remembered directories', () => {
    expect(getDialogDefaultPath('D:\\Workspace\\layouts', 'linkassist-layout.json'))
      .toBe('D:\\Workspace\\layouts\\linkassist-layout.json');
    expect(getDialogDefaultPath('/home/me/layouts/', 'linkassist-layout.json'))
      .toBe('/home/me/layouts/linkassist-layout.json');
  });

  it('normalizes missing dialog directory entries independently', () => {
    expect(normalizeFileDialogDirs({ layout: 'D:\\layouts', protocol: 'D:\\protocols' })).toEqual({
      layout: 'D:\\layouts',
      mcp: '',
      protocol: 'D:\\protocols',
      script: '',
    });
  });
});
