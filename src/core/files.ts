import { createHash } from 'node:crypto';
import type { SkillFile } from '../shared/types';

export const LIMITS = Object.freeze({ files: 512, fileBytes: 8 * 1024 * 1024, totalBytes: 32 * 1024 * 1024, archiveBytes: 32 * 1024 * 1024, compressionRatio: 250 });
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export function safeRelativePath(value: string): string {
  if (!value || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('A package contains an invalid filename.');
  const normalized = value.replace(/\\/g, '/').normalize('NFC');
  if (normalized.startsWith('/') || /^[a-z]:/i.test(normalized) || normalized.includes(':')) throw new Error('Absolute paths are not permitted in skill packages.');
  const parts = normalized.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) throw new Error('A package contains an unsafe filename.');
  return normalized;
}

export function fileBytes(file: Pick<SkillFile, 'content' | 'encoding'>): Buffer {
  if (file.encoding === 'utf8') return Buffer.from(file.content, 'utf8');
  if (file.encoding !== 'base64' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) throw new Error('A file has invalid encoded contents.');
  return Buffer.from(file.content, 'base64');
}

export function fileFromBytes(path: string, bytes: Buffer): SkillFile {
  let content: string;
  let encoding: 'utf8' | 'base64' = 'utf8';
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (/\u0000/.test(content) || /[\u0001-\u0008\u000b\u000c\u000e-\u001a]/.test(content)) throw new Error('binary');
  } catch {
    content = bytes.toString('base64'); encoding = 'base64';
  }
  return { path: safeRelativePath(path), content, encoding, size: bytes.length, sha256: digest(bytes) };
}

export function normalizeFiles(files: SkillFile[]): SkillFile[] {
  if (!Array.isArray(files) || !files.length || files.length > LIMITS.files) throw new Error(`Choose a package containing between 1 and ${LIMITS.files} files.`);
  const names = new Set<string>();
  let total = 0;
  const normalized = files.map(file => {
    const path = safeRelativePath(file.path);
    const key = path.toLocaleLowerCase('en-US');
    if (names.has(key)) throw new Error('The package has duplicate filenames (including case-only differences).');
    names.add(key);
    if (typeof file.content !== 'string' || file.content.length > LIMITS.fileBytes * 1.4) throw new Error('A file exceeds the 8 MB import limit.');
    const bytes = fileBytes(file);
    if (file.encoding === 'utf8' && /[\u0000-\u0008\u000b\u000c\u000e-\u001a]/.test(file.content)) throw new Error('A text file contains binary control characters. Keep it as a binary asset or remove those characters.');
    if (bytes.length > LIMITS.fileBytes || (total += bytes.length) > LIMITS.totalBytes) throw new Error('This package exceeds the 8 MB per-file or 32 MB total import limit.');
    return { path, content: file.encoding === 'base64' ? bytes.toString('base64') : file.content, encoding: file.encoding, size: bytes.length, sha256: digest(bytes), ...(file.excluded ? { excluded: true } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  for (const file of normalized) {
    const parts = file.path.split('/');
    for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/').toLowerCase())) throw new Error('A filename conflicts with a parent folder in this package.');
  }
  return normalized;
}

export function hashFiles(files: SkillFile[]): string {
  return digest(JSON.stringify(normalizeFiles(files).map(f => [f.path, f.encoding, f.sha256, !!f.excluded])));
}
