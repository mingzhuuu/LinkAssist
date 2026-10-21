export type FileDialogDirectoryKind = 'layout' | 'mcp' | 'protocol' | 'script';

export type FileDialogDirectories = Record<FileDialogDirectoryKind, string>;

export const DEFAULT_FILE_DIALOG_DIRS: FileDialogDirectories = {
  layout: '',
  mcp: '',
  protocol: '',
  script: '',
};

export function normalizeFileDialogDirs(value: unknown): FileDialogDirectories {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_FILE_DIALOG_DIRS };
  }

  const candidate = value as Partial<Record<FileDialogDirectoryKind, unknown>>;

  return {
    layout: typeof candidate.layout === 'string' ? candidate.layout : '',
    mcp: typeof candidate.mcp === 'string' ? candidate.mcp : '',
    protocol: typeof candidate.protocol === 'string' ? candidate.protocol : '',
    script: typeof candidate.script === 'string' ? candidate.script : '',
  };
}

export function getParentDirectory(filePath: string): string {
  const normalized = filePath.trim();
  const separatorIndex = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (separatorIndex <= 0) {
    return '';
  }
  return normalized.slice(0, separatorIndex);
}

export function getDialogDefaultPath(directory: string, fileName?: string): string | undefined {
  const baseDir = directory.trim();
  if (!baseDir) {
    return fileName;
  }
  if (!fileName) {
    return baseDir;
  }

  const separator = baseDir.includes('\\') ? '\\' : '/';
  return `${baseDir.replace(/[\\/]+$/, '')}${separator}${fileName}`;
}
