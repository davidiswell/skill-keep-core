import { parse as parseYaml } from 'yaml';
import type { SkillFile, SkillRecord } from '../shared/types';
import { portabilityContractSchema, type PortabilityContract } from './contracts';
import { fileFromBytes, normalizeFiles, safeRelativePath } from './files';

export const PORTABILITY_CONTRACT_PATH = 'skillkeep.json';
const MAX_CONTRACT_BYTES = 256 * 1024;
export function validatePortabilityContract(value: unknown): PortabilityContract {
  const result = portabilityContractSchema.safeParse(value);
  if (!result.success) throw new Error('The portability contract has missing, unsupported, or oversized fields.');
  const contract = result.data;
  if (Buffer.byteLength(JSON.stringify(contract)) > MAX_CONTRACT_BYTES) throw new Error('The portability contract exceeds 256 KB.');
  const unique = (values: string[], label: string): void => {
    if (new Set(values.map(value => value.toLowerCase())).size !== values.length) throw new Error(`The portability contract has duplicate ${label}.`);
  };
  unique(contract.inputs.map(input => input.id), 'input identifiers');
  unique(contract.resources.map(resource => resource.path), 'resource paths');
  unique(contract.provenance.noticePaths, 'notice paths');
  for (const path of [...contract.resources.map(resource => resource.path), ...contract.provenance.noticePaths]) {
    if (safeRelativePath(path) !== path) throw new Error('Contract resources must use exact portable relative paths.');
  }
  if (contract.provenance.sourceUrl) {
    const url = new URL(contract.provenance.sourceUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('The provenance source must be a public-format HTTP or HTTPS URL without credentials.');
  }
  return contract;
}
export function parsePortabilityContract(text: string): PortabilityContract {
  if (Buffer.byteLength(text) > MAX_CONTRACT_BYTES) throw new Error('The portability contract exceeds 256 KB.');
  let value: unknown;
  try {
    const json = text.replace(/^\uFEFF/, '');
    value = JSON.parse(json);
    // JSON.parse keeps the last duplicate key. Reject ambiguity before other apps interpret it differently.
    parseYaml(json, { uniqueKeys: true, maxAliasCount: 0 });
  } catch { throw new Error('The portability contract must contain valid JSON with no duplicate keys.'); }
  return validatePortabilityContract(value);
}
export function readPortabilityContract(files: SkillFile[]): PortabilityContract | null {
  const file = files.find(file => !file.excluded && file.path.toLowerCase() === PORTABILITY_CONTRACT_PATH);
  if (!file) return null;
  if (file.path !== PORTABILITY_CONTRACT_PATH || file.encoding !== 'utf8') throw new Error('Use the exact filename skillkeep.json with readable UTF-8 JSON.');
  return parsePortabilityContract(file.content);
}
export function writePortabilityContract(files: SkillFile[], value: unknown): SkillFile[] {
  const contract = validatePortabilityContract(value);
  return normalizeFiles([...files.filter(file => file.path.toLowerCase() !== PORTABILITY_CONTRACT_PATH), fileFromBytes(PORTABILITY_CONTRACT_PATH, Buffer.from(JSON.stringify(contract, null, 2) + '\n'))]);
}

export interface PortabilityIssue { title: string; detail: string; filePath: string; excerpt: string; blocking: boolean }
export function inspectPortability(files: SkillFile[]): PortabilityIssue[] {
  const issues: PortabilityIssue[] = [];
  let contract: PortabilityContract | null;
  try { contract = readPortabilityContract(files); } catch (error) {
    return [{ title: 'Fix portability contract', detail: error instanceof Error ? error.message : 'The portability contract is invalid.', filePath: PORTABILITY_CONTRACT_PATH, excerpt: PORTABILITY_CONTRACT_PATH, blocking: true }];
  }
  if (!contract) return issues;
  const included = new Set(files.filter(file => !file.excluded).map(file => file.path));
  for (const path of new Set([...contract.resources.map(resource => resource.path), ...contract.provenance.noticePaths])) if (!included.has(path)) {
    issues.push({ title: 'Contract resource is missing or excluded', detail: 'A declared package resource must be included under its exact path. Update the contract or restore the reviewed resource. Declared license notices must be preserved.', filePath: PORTABILITY_CONTRACT_PATH, excerpt: path, blocking: true });
  }
  if (contract.provenance.origin !== 'original' || /^(?:unknown|unspecified|none|unlicensed)$/i.test(contract.provenance.license.trim())) {
    issues.push({ title: 'Review declared reuse rights', detail: 'Authorship and license fields are user-supplied claims. Review the source license, attribution, modifications, and permission to distribute this package. This declaration is not authenticated employer permission.', filePath: PORTABILITY_CONTRACT_PATH, excerpt: `origin: ${contract.provenance.origin}; license: ${contract.provenance.license}`, blocking: false });
  }
  return issues;
}

function conventionalNotice(path: string): boolean {
  return /(?:^|\/)(?:licen[cs]e(?:[._-].*)?|copying(?:[._-].*)?|notice(?:[._-].*)?|authors(?:[._-].*)?|copyright(?:[._-].*)?|third[-_]party[-_](?:notices|licenses)(?:\..*)?)$/i.test(path);
}
function declarations(files: SkillFile[]): { authors: string[]; license?: string } {
  const file = files.find(file => file.path === 'SKILL.md' && file.encoding === 'utf8');
  const frontmatter = file?.content.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
  if (!frontmatter || frontmatter.length > 65536) return { authors: [] };
  try {
    const data: unknown = parseYaml(frontmatter, { maxAliasCount: 20, uniqueKeys: true });
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { authors: [] };
    const values = data as Record<string, unknown>;
    const authors = [values.author, values.authors].flatMap(value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    return { authors, ...(typeof values.license === 'string' ? { license: values.license } : {}) };
  } catch { return { authors: [] }; }
}

/** Preserve known attribution; this does not determine legal rights or discover every possible notice. */
export function validateNoticePreservation(record: SkillRecord, currentFiles: SkillFile[]): void {
  const initial = record.versions.find(version => version.kind === 'import') || record.versions[0];
  const baselineId = (record as SkillRecord & { baselineVersionId?: string }).baselineVersionId;
  const baseline = baselineId ? record.versions.find(version => version.id === baselineId) : undefined;
  const current = normalizeFiles(currentFiles).filter(file => !file.excluded);
  const currentContract = readPortabilityContract(current);
  const currentDeclarations = declarations(current);
  for (const version of new Set([initial, baseline].filter(version => !!version))) {
    const original = normalizeFiles(version!.files);
    let originalContract: PortabilityContract | null = null;
    try { originalContract = readPortabilityContract(original.map(file => ({ ...file, excluded: false }))); } catch {
      // A malformed original declaration cannot be used to erase conventional notices.
    }
    const noticePaths = new Set([...original.filter(file => conventionalNotice(file.path)).map(file => file.path), ...(originalContract?.provenance.noticePaths || [])]);
    for (const path of noticePaths) {
      const source = original.find(file => file.path === path);
      const destination = current.find(file => file.path === path);
      if (!source || !destination || source.sha256 !== destination.sha256 || source.encoding !== destination.encoding) throw new Error('An original license or attribution notice was removed or changed. Restore the exact notice before export; conflicting privacy and reuse rights need human review.');
    }
    // Inline copyright/SPDX notices may accompany methods in ordinary text files.
    for (const source of original.filter(file => file.encoding === 'utf8' && !conventionalNotice(file.path))) {
      const notices = source.content.split(/\r?\n/).filter(line => /(?:\bcopyright\s+(?:\(c\)|©|\d{4})|©\s*\d{4}|SPDX-(?:License-Identifier|FileCopyrightText):)/i.test(line));
      if (!notices.length) continue;
      const destination = current.find(file => file.path === source.path && file.encoding === 'utf8');
      if (!destination || notices.some(line => !destination.content.split(/\r?\n/).includes(line))) throw new Error('An original inline copyright or license notice was removed or changed. Restore it before export.');
    }
    const originalDeclarations = declarations(original);
    if (originalDeclarations.authors.some(author => !currentDeclarations.authors.includes(author)) || (originalDeclarations.license !== undefined && originalDeclarations.license !== currentDeclarations.license)) throw new Error('Original SKILL.md authorship or license metadata must be preserved before export.');
    if (originalContract && (!currentContract || originalContract.provenance.authors.some(author => !currentContract.provenance.authors.includes(author)) || originalContract.provenance.license !== currentContract.provenance.license || originalContract.provenance.noticePaths.some(path => !currentContract.provenance.noticePaths.includes(path)) || (originalContract.provenance.sourceUrl && originalContract.provenance.sourceUrl !== currentContract.provenance.sourceUrl) || (originalContract.provenance.origin !== 'original' && currentContract.provenance.origin === 'original'))) throw new Error('Original provenance and license declarations must be preserved before export. Additional authors and modification notes may be added.');
  }
}
