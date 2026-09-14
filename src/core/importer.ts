import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import AdmZip from 'adm-zip';
import { parseDocument } from 'yaml';
import type { SkillFile, SourceFormat } from '../shared/types';
import { fileFromBytes, LIMITS, normalizeFiles, safeRelativePath } from './files';

export interface ImportedSkill { name: string; description: string; sourceFormat: SourceFormat; files: SkillFile[]; warnings: string[] }

export function readMetadata(content: string): { name?: string; description?: string; error?: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) return { error: 'SKILL.md needs YAML frontmatter with a name and description.' };
  if (match[1].length > 64 * 1024) return { error: 'The skill metadata is too large.' };
  try {
    const doc = parseDocument(match[1], { uniqueKeys: true });
    if (doc.errors.length) return { error: 'The YAML frontmatter could not be read. Check its formatting.' };
    const data = doc.toJS({ maxAliasCount: 20 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'The skill metadata must be a YAML object.' };
    return { name: typeof data.name === 'string' ? data.name.trim() : undefined, description: typeof data.description === 'string' ? data.description.trim() : undefined };
  } catch { return { error: 'The YAML frontmatter could not be read safely.' }; }
}

function finishImport(files: SkillFile[], fallback: string, sourceFormat: SourceFormat = 'agent-skills'): ImportedSkill {
  let normalized = normalizeFiles(files);
  const warnings: string[] = [];
  // Strip only a single common wrapper. Keep every companion file in the review inventory.
  while (normalized.every(f => f.path.includes('/')) && new Set(normalized.map(f => f.path.split('/')[0])).size === 1) {
    normalized = normalizeFiles(normalized.map(f => ({ ...f, path: f.path.slice(f.path.indexOf('/') + 1) })));
  }
  const roots = normalized.filter(f => /(?:^|\/)SKILL\.md$/i.test(f.path));
  if (roots.length > 1) throw new Error('This package contains multiple skills. Import each skill folder separately so every file has a clear review.');
  const pluginManifest = normalized.find(f => ['plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json'].includes(f.path.toLowerCase()));
  if (pluginManifest && roots.length === 1 && /^skills\/[^/]+\/SKILL\.md$/i.test(roots[0].path)) {
    const skillPrefix = roots[0].path.slice(0, -'SKILL.md'.length);
    const skillFiles = normalized.filter(f => f.path.startsWith(skillPrefix)).map(f => ({ ...f, path: f.path.slice(skillPrefix.length) }));
    let contextPrefix = 'imported-plugin';
    while (skillFiles.some(f => f.path === contextPrefix || f.path.startsWith(contextPrefix + '/'))) contextPrefix += '-context';
    const otherFiles = normalized.filter(f => !f.path.startsWith(skillPrefix)).map(f => ({ ...f, path: `${contextPrefix}/${f.path}` }));
    normalized = normalizeFiles([...skillFiles, ...otherFiles]);
    sourceFormat = pluginManifest.path.toLowerCase().startsWith('.claude-plugin/') ? 'claude' : 'chatgpt';
    warnings.push(`Imported one skill from a plugin bundle. Plugin-level files are retained under ${contextPrefix}/ for review; connectors and hooks are not installed. Review any references that depended on the former plugin layout.`);
  }
  const main = normalized.find(f => f.path.toLowerCase() === 'skill.md');
  const metadata = main?.encoding === 'utf8' ? readMetadata(main.content) : {};
  if (!main) warnings.push('No root SKILL.md was found. Add one in the editor before approving this package.');
  if (normalized.some(f => f.encoding === 'base64')) warnings.push('Binary files are inventoried but cannot be cleared by the text scanner. Exclude them before export.');
  return { name: (metadata.name || fallback || 'Untitled skill').replace(/[\u0000-\u001f]/g, '').slice(0, 120), description: (metadata.description || '').slice(0, 1024), sourceFormat, files: normalized, warnings };
}

async function readFolder(root: string): Promise<SkillFile[]> {
  const rootReal = await realpath(root);
  const files: SkillFile[] = [];
  let total = 0;
  let entryCount = 0;
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 24) throw new Error('This folder is nested too deeply.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++entryCount > LIMITS.files * 2) throw new Error('This folder has too many files and subfolders. Choose only the skill folder.');
      const path = join(directory, entry.name);
      const before = await lstat(path);
      if (before.isSymbolicLink() || entry.isSymbolicLink()) throw new Error('Symbolic links and junctions are not imported. Choose a folder containing actual files.');
      const actual = await realpath(path);
      const rel = relative(rootReal, actual);
      if (rel.startsWith('..') || resolve(rootReal, rel).toLowerCase() !== actual.toLowerCase()) throw new Error('A folder entry points outside the selected skill.');
      if (before.isDirectory()) { await visit(path, depth + 1); continue; }
      if (!before.isFile()) throw new Error('This folder contains an unsupported filesystem entry.');
      if (files.length >= LIMITS.files || before.size > LIMITS.fileBytes || (total += before.size) > LIMITS.totalBytes) throw new Error('This folder exceeds the package limits: 512 files, 8 MB per file, 32 MB total.');
      const content = await readFile(path);
      const after = await lstat(path);
      if (after.isSymbolicLink() || !after.isFile() || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || (await realpath(path)) !== actual) throw new Error('A file changed during import. Please try again.');
      files.push(fileFromBytes(relative(root, path), content));
    }
  }
  await visit(root, 0);
  return normalizeFiles(files);
}

function readArchive(bytes: Buffer): SkillFile[] {
  if (bytes.length > LIMITS.archiveBytes) throw new Error('The archive exceeds the 32 MB import limit.');
  let zip: AdmZip;
  try { zip = new AdmZip(bytes); } catch { throw new Error('This archive could not be opened. Choose a valid ZIP or .skill file.'); }
  const entries = zip.getEntries();
  if (entries.length > LIMITS.files * 2) throw new Error('This archive has too many entries.');
  let total = 0;
  let fileCount = 0;
  const names = new Set<string>();
  // Validate the entire directory before decompressing any content.
  for (const entry of entries) {
    const entryPath = safeRelativePath(entry.entryName.replace(/[\\/]$/, ''));
    const key = entryPath.toLowerCase();
    if (names.has(key)) throw new Error('This archive contains duplicate filenames.');
    names.add(key);
    const mode = (entry.attr >>> 16) & 0xf000;
    if (mode === 0xa000 || (mode !== 0 && mode !== 0x8000 && mode !== 0x4000)) throw new Error('Archive links and special files are not supported.');
    if (entry.header.flags & 1) throw new Error('Encrypted archives are not supported. Decrypt the selected file locally before importing.');
    if (entry.isDirectory) continue;
    const size = entry.header.size;
    const compressed = entry.header.compressedSize;
    if (++fileCount > LIMITS.files || size > LIMITS.fileBytes || (total += size) > LIMITS.totalBytes || (size > 1024 * 1024 && size / Math.max(1, compressed) > LIMITS.compressionRatio)) throw new Error('This archive exceeds the safe size or compression limits.');
  }
  return normalizeFiles(entries.filter(e => !e.isDirectory).map(entry => {
    let data: Buffer;
    try { data = entry.getData(); } catch { throw new Error('A file in this archive is damaged or uses unsupported compression.'); }
    if (data.length !== entry.header.size) throw new Error('An archive file has an inconsistent size.');
    return fileFromBytes(entry.entryName, data);
  }));
}

export async function importSkillFromPath(path: string): Promise<ImportedSkill[]> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error('Choose the original folder or file instead of a symbolic link.');
  const name = basename(path, extname(path));
  if (stat.isDirectory()) return [finishImport(await readFolder(path), basename(path))];
  if (!stat.isFile()) throw new Error('Choose a skill folder, ZIP, .skill, Markdown, or text file.');
  const extension = extname(path).toLowerCase();
  if (!['.zip', '.skill', '.md', '.txt'].includes(extension)) throw new Error('Choose a ZIP, .skill, Markdown, or text file, or import a skill folder.');
  if (stat.size > LIMITS.archiveBytes) throw new Error('The selected file exceeds the 32 MB import limit.');
  const content = await readFile(path);
  if (extension === '.zip' || extension === '.skill') return [finishImport(readArchive(content), name)];
  const decoded = fileFromBytes('SKILL.md', content);
  if (decoded.encoding !== 'utf8') throw new Error('Text imports must contain valid UTF-8 text.');
  return [importSkillFromText(name, decoded.content)];
}

export function importSkillFromText(name: string, content: string): ImportedSkill {
  if (!content.trim()) throw new Error('Add some instructions before importing this skill.');
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64).replace(/-$/, '') || 'my-skill';
  const wrapped = /^\uFEFF?---\r?\n/.test(content) ? content : `---\nname: ${slug}\ndescription: Reusable instructions imported for review.\n---\n\n${content}`;
  return finishImport([fileFromBytes('SKILL.md', Buffer.from(wrapped))], name || 'My skill', 'text');
}

export function createSampleSkill(): ImportedSkill {
  const sample = importSkillFromText('Financial workbook workflow', `---\nname: financial-workbook-workflow\ndescription: Build a traceable financial workbook from supplied statements, with consistent dates and reconciliation checks.\n---\n\n# Financial workbook workflow\n\nThis fictional example shows what a skill review looks like.\n\n## Workflow\n1. Inventory the supplied statements and identify monthly versus year-to-date figures.\n2. Map source accounts to stable keys; keep display labels separate.\n3. Use real date values for period headers and formulas for all calculated totals.\n4. Check that detail reconciles to source totals and record unresolved differences.\n5. Preserve the user’s manual edits and recheck footnotes after moving columns.\n\n## Context to generalize\nUse the internal reporting folder C:\\ExampleCompany\\Finance\\Reports.\nContact the reviewer at analyst@example.test before finalizing.\nThe confidential revenue forecast is $12,345 for the sample period.\n\n## Resources\nSee [workbook checklist](references/checklist.md).\n`);
  sample.files.push(fileFromBytes('references/checklist.md', Buffer.from('# Workbook checklist\n\n- Confirm units and currency.\n- Keep source references next to mapped accounts.\n- Recalculate totals and inspect differences.\n- Record assumptions without inventing missing figures.\n')));
  sample.files = normalizeFiles(sample.files);
  sample.name = 'Financial workbook workflow';
  sample.description = 'A fictional example: retain the workbook method while removing company context.';
  return sample;
}
