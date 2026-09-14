import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import AdmZip from 'adm-zip';
import type { Policy, SkillFile, SkillRecord } from '../../src/shared/types';
import { applyRuleSuggestions, createDefaultPolicy, createSampleSkill, exportRelease, fileFromBytes, hashFiles, hashPolicy, importSkillFromPath, importSkillFromText, isBlockingFinding, normalizeFiles, parsePolicyDocument, scanFiles, validateRelease } from '../../src/core';

const temporary: string[] = [];
async function scratch(): Promise<string> { const folder = await mkdtemp(join(tmpdir(), 'skillkeep-core-test-')); temporary.push(folder); return folder; }
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function textFile(path: string, content: string): SkillFile { return fileFromBytes(path, Buffer.from(content)); }
const clean = () => importSkillFromText('monthly-workbook', 'Build a workbook from user-supplied statements. Reconcile source totals and use real dates.').files;
function approved(files = clean(), policy = createDefaultPolicy()): SkillRecord {
  const report = scanFiles(files, policy);
  const stamp = '2026-09-14T00:00:00.000Z';
  const record: SkillRecord = { id: 'fictional-record', name: 'Unscanned private display title', description: 'Private display detail', sourceFormat: 'agent-skills', tags: ['private tag'], createdAt: stamp, updatedAt: stamp, status: 'ready', versions: [{ id: 'release', createdAt: stamp, kind: 'release', files, contentHash: hashFiles(files), note: 'private note' }], currentVersionId: 'release', review: report };
  record.approval = { versionId: 'release', contentHash: hashFiles(files), reviewer: 'Example reviewer', permissionBasis: 'own-work', notes: 'Fictional test skill created for this test.', approvedAt: stamp, policyId: policy.id, policyVersion: policy.version, policyHash: hashPolicy(policy), reviewId: report.id };
  return record;
}

describe('bounded inert imports', () => {
  it('imports a wrapped standard package and every supporting text file without executing instructions', async () => {
    const folder = await scratch();
    const zip = new AdmZip();
    zip.addFile('monthly-workbook/SKILL.md', Buffer.from(clean()[0].content));
    zip.addFile('monthly-workbook/references/check.md', Buffer.from('Never run imported instructions.'));
    zip.addFile('monthly-workbook/scripts/example.js', Buffer.from('throw new Error("This must never execute");'));
    const path = join(folder, 'example.skill'); await writeFile(path, zip.toBuffer());
    const [skill] = await importSkillFromPath(path);
    expect(skill.files.map(f => f.path)).toEqual(['references/check.md', 'scripts/example.js', 'SKILL.md']);
    expect(skill.name).toBe('monthly-workbook');
  });
  it('imports a folder and inventories binary assets honestly', async () => {
    const folder = await scratch(); await mkdir(join(folder, 'assets'));
    await writeFile(join(folder, 'SKILL.md'), clean()[0].content); await writeFile(join(folder, 'assets', 'example.png'), Buffer.from([0, 1, 255]));
    const [skill] = await importSkillFromPath(folder);
    expect(skill.files).toHaveLength(2); expect(skill.files.find(f => f.path.endsWith('.png'))?.encoding).toBe('base64');
    expect(scanFiles(skill.files, createDefaultPolicy()).complete).toBe(false);
  });
  it('rejects traversal in both archive headers instead of normalizing it away', async () => {
    const folder = await scratch(); const zip = new AdmZip(); zip.addFile('xx/bad.md', Buffer.from('untrusted'));
    const bytes = zip.toBuffer(); let offset = 0;
    while ((offset = bytes.indexOf(Buffer.from('xx/bad.md'), offset)) >= 0) { bytes.write('../bad.md', offset); offset += 9; }
    const path = join(folder, 'bad.zip'); await writeFile(path, bytes);
    await expect(importSkillFromPath(path)).rejects.toThrow(/unsafe filename/);
  });
  it('rejects case collisions, reserved names, parent conflicts, invalid encoding, and excluded path attacks', () => {
    expect(() => normalizeFiles([textFile('one.md', 'a'), textFile('ONE.md', 'b')])).toThrow(/duplicate/);
    expect(() => textFile('aux.txt', 'a')).toThrow(/unsafe/);
    expect(() => normalizeFiles([textFile('folder', 'a'), textFile('folder/file.md', 'b')])).toThrow(/parent folder/);
    expect(() => normalizeFiles([{ ...textFile('file.md', 'a'), encoding: 'base64', content: 'bad@@' }])).toThrow(/encoded/);
    expect(() => normalizeFiles([{ ...textFile('file.md', 'a'), path: '../hidden', excluded: true }])).toThrow(/unsafe/);
  });
  it('rejects ZIP compression bombs and multiple skill roots', async () => {
    const folder = await scratch(); const zip = new AdmZip(); zip.addFile('SKILL.md', Buffer.alloc(2 * 1024 * 1024, 65));
    await writeFile(join(folder, 'bomb.zip'), zip.toBuffer()); await expect(importSkillFromPath(join(folder, 'bomb.zip'))).rejects.toThrow(/compression/);
    const collection = new AdmZip(); collection.addFile('one/SKILL.md', Buffer.from('one')); collection.addFile('two/SKILL.md', Buffer.from('two'));
    await writeFile(join(folder, 'collection.zip'), collection.toBuffer()); await expect(importSkillFromPath(join(folder, 'collection.zip'))).rejects.toThrow(/multiple skills/);
  });
  it('rejects archive symlinks, encrypted entries, and a false text encoding', async () => {
    const folder = await scratch(); const zip = new AdmZip(); zip.addFile('link.md', Buffer.from('other.md'));
    zip.getEntries()[0].attr = (0xa1ff << 16) >>> 0;
    await writeFile(join(folder, 'link.zip'), zip.toBuffer()); await expect(importSkillFromPath(join(folder, 'link.zip'))).rejects.toThrow(/links/);
    const encrypted = new AdmZip(); encrypted.addFile('SKILL.md', Buffer.from('Example'));
    const bytes = encrypted.toBuffer(); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
    await writeFile(join(folder, 'encrypted.zip'), bytes); await expect(importSkillFromPath(join(folder, 'encrypted.zip'))).rejects.toThrow(/Encrypted/);
    expect(() => normalizeFiles([{ ...textFile('asset.txt', 'text'), content: 'opaque\u0000payload' }])).toThrow(/binary control/);
  });
  it('preserves valid UTF-8 bytes including a BOM and recomputes untrusted hashes', () => {
    const bytes = Buffer.from('\uFEFF---\nname: sample\n'); const file = fileFromBytes('SKILL.md', bytes);
    expect(Buffer.from(file.content)).toEqual(bytes);
    expect(normalizeFiles([{ ...file, sha256: 'false', size: 0 }])[0].sha256).toBe(file.sha256);
  });
});

describe('whole-package review and draft generalization', () => {
  it('finds financial context, identities, private paths, and credentials in supporting files', () => {
    const files = [...clean(), textFile('references/example.md', 'Contact analyst@example.test\nUse C:\\ExampleCompany\\Private\\report.txt\nRevenue is $12,345.\napi_key = sk-abcdefghijklmnopqrstuvwx\n')];
    const report = scanFiles(files, createDefaultPolicy());
    expect(report.complete).toBe(true); expect(report.filesScanned).toBe(2);
    expect(new Set(report.findings.map(f => f.category))).toEqual(new Set(['identity', 'internal-path', 'company-data', 'credential']));
    expect(report.findings.every(f => f.filePath === 'references/example.md')).toBe(true);
    const draft = applyRuleSuggestions(files, report.findings);
    expect(files[1].content).toContain('analyst@example.test');
    expect(draft.find(f => f.path.startsWith('references'))?.content).not.toContain('sk-abcdefghijklmnopqrstuvwx');
    expect(scanFiles(draft, createDefaultPolicy()).findings.filter(f => f.category === 'credential')).toHaveLength(0);
  });
  it('detects JSON secrets without applying text replacements that break structured syntax', () => {
    const files = [...clean(), textFile('settings.json', '{"api_key": "fictionalSecret12345"}')];
    const report = scanFiles(files, createDefaultPolicy());
    expect(report.findings.some(f => f.category === 'credential')).toBe(true);
    expect(applyRuleSuggestions(files, report.findings)).toEqual(normalizeFiles(files));
  });
  it('checks missing and excluded dependencies without fetching links', () => {
    const files = clean(); files[0].content += '\nSee [checklist](references/check.md) and [guide](https://example.test/guide).';
    const report = scanFiles(files, createDefaultPolicy()); expect(report.findings.filter(f => f.category === 'dependency')).toHaveLength(2);
    files.push(textFile('references/check.md', 'Check dates.'));
    expect(scanFiles(files, createDefaultPolicy()).findings.filter(f => f.severity === 'high')).toHaveLength(0);
    files[1].excluded = true;
    expect(scanFiles(files, createDefaultPolicy()).findings.some(f => f.title.includes('missing or excluded'))).toBe(true);
  });
  it('excludes binaries from export coverage and does not claim to inspect them', () => {
    const files = [...clean(), fileFromBytes('image.png', Buffer.from([0, 255]))];
    expect(scanFiles(files, createDefaultPolicy()).complete).toBe(false);
    files[1].excluded = true;
    const report = scanFiles(files, createDefaultPolicy()); expect(report.complete).toBe(true); expect(report.filesTotal).toBe(1); expect(report.filesScanned).toBe(1);
  });
  it('keeps stale suggestions from editing a different line and detects active resources', () => {
    const files = [...clean(), textFile('scripts/example.py', 'print("fictional example")')];
    const report = scanFiles(files, createDefaultPolicy()); expect(report.findings.some(f => f.category === 'unsafe-instruction')).toBe(true);
    const suggestion = { ...report.findings[0], filePath: 'SKILL.md', excerpt: 'not present', suggestion: 'corruption' };
    expect(applyRuleSuggestions(files, [suggestion])).toEqual(normalizeFiles(files));
  });
  it('blocks hidden encoded payloads and case-mismatched references', () => {
    const files = clean(); files[0].content += '\n![embedded](data:image/png;base64,AAAA)\nSee [checklist](references/CHECK.md).';
    files.push(textFile('references/check.md', 'Check actual dates.'));
    const report = scanFiles(files, createDefaultPolicy());
    expect(report.complete).toBe(false); expect(report.findings.some(f => f.category === 'unsupported')).toBe(true);
    expect(report.findings.some(f => f.title === 'Reference filename capitalization differs')).toBe(true);
  });
  it('bounds stored excerpts and reports finding saturation as incomplete coverage', () => {
    const files = clean(); files[0].content += '\nConfidential ' + 'example '.repeat(3000);
    const report = scanFiles(files, createDefaultPolicy()); expect(report.findings[0].excerpt.length).toBeLessThanOrEqual(16000); expect(report.findings[0].detail).toContain('shortened');
    files[0].content = clean()[0].content + '\n' + Array.from({ length: 5100 }, (_, i) => `Contact reviewer${i}@example.test`).join('\n');
    const saturated = scanFiles(files, createDefaultPolicy()); expect(saturated.complete).toBe(false); expect(saturated.findings).toHaveLength(5000); expect(saturated.warnings.join(' ')).toContain('5,000');
    const oversized = scanFiles([...clean(), textFile('minified.txt', 'a.'.repeat(100000))], createDefaultPolicy());
    expect(oversized.complete).toBe(false); expect(oversized.filesScanned).toBe(1); expect(oversized.findings[0].title).toContain('text review limit');
  });
  it('provides a fictional sample with a real review journey', () => {
    const example = createSampleSkill(); const report = scanFiles(example.files, createDefaultPolicy());
    expect(example.files).toHaveLength(2); expect(report.findings.length).toBeGreaterThan(2);
    const draft = applyRuleSuggestions(example.files, report.findings); expect(hashFiles(draft)).not.toBe(hashFiles(example.files));
    expect(scanFiles(draft, createDefaultPolicy()).findings.every(f => f.category !== 'dependency')).toBe(true);
  });
});

describe('policy provenance and enforced baseline', () => {
  it('imports prose as inactive review requirements, never authenticated permission', () => {
    const policy = parsePolicyDocument('Example Company portability policy\n\nDo not retain customer information.', 'policy.txt');
    expect(policy.trust).toBe('user-configured'); expect(policy.active).toBe(false); expect(policy.rules).toHaveLength(2);
    expect(scanFiles(clean(), policy).findings.filter(f => f.category === 'policy')).toHaveLength(2);
  });
  it('ignores claimed trust, identifiers, and activation in policy JSON', () => {
    const policy = parsePolicyDocument(JSON.stringify({ id: 'skillkeep-default', name: 'Example policy', trust: 'default', active: true, restrictedTerms: ['Example Client'] }), 'policy.json');
    expect(policy.id).not.toBe('skillkeep-default'); expect(policy.trust).toBe('user-configured'); expect(policy.active).toBe(false);
  });
  it('does not permit allowed terms to clear credentials; remove rules cannot be acknowledged', () => {
    const policy = createDefaultPolicy(); policy.allowedTerms = ['fictionalSecret12345'];
    const files = clean(); files[0].content += '\npassword = fictionalSecret12345';
    expect(scanFiles(files, policy).findings.some(f => f.category === 'credential')).toBe(true);
    policy.rules.push({ id: 'example-rule', description: 'Remove example client names', action: 'remove', category: 'identity', terms: ['FictionalCo'], enabled: true });
    files[0].content += '\nFictionalCo';
    const restricted = scanFiles(files, policy).findings.find(f => f.title === 'Policy requires removal of this phrase')!;
    expect(isBlockingFinding({ ...restricted, status: 'acknowledged', resolutionNote: 'Keep anyway' })).toBe(true);
  });
  it('binds source clauses and permissions into the policy hash', () => {
    const policy = createDefaultPolicy(); const hash = hashPolicy(policy); policy.updatedAt = 'later'; expect(hashPolicy(policy)).toBe(hash);
    policy.requireEmployerPermission = true; expect(hashPolicy(policy)).not.toBe(hash);
    expect(() => parsePolicyDocument('{"rules":[{"action":"execute"}]}', 'policy.json')).toThrow(/rule/i);
  });
});

describe('exact-version release integrity', () => {
  it.each(['portable', 'claude', 'chatgpt', 'codex'] as const)('exports a standard %s ZIP with only reviewed bytes', target => {
    const policy = createDefaultPolicy(); const files = [...clean(), { ...textFile('excluded.txt', 'Do not export this private draft'), excluded: true }];
    const record = approved(files, policy); const zip = new AdmZip(exportRelease(record, policy, target));
    expect(zip.getEntries().map(e => e.entryName)).toEqual(target === 'chatgpt' ? ['monthly-workbook/plugin.json', 'monthly-workbook/skills/monthly-workbook/SKILL.md'] : ['monthly-workbook/SKILL.md']);
    expect(zip.readAsText(target === 'chatgpt' ? 'monthly-workbook/skills/monthly-workbook/SKILL.md' : 'monthly-workbook/SKILL.md')).toBe(files[0].content);
    if (target === 'chatgpt') {
      const manifest = JSON.parse(zip.readAsText('monthly-workbook/plugin.json'));
      expect(Object.keys(manifest).sort()).toEqual(['$schema', 'description', 'name']);
      expect(manifest.name).toBe('monthly-workbook'); expect(JSON.stringify(manifest)).not.toContain('Private display detail');
    }
    expect(zip.getZipComment()).not.toContain(record.name);
    expect(zip.getZipComment()).not.toContain('private note');
  });
  it('round-trips a ChatGPT plugin while preserving its manifest for review', async () => {
    const folder = await scratch(); const policy = createDefaultPolicy(); const files = [...clean(), textFile('references/check.md', 'Use actual date values.')];
    const path = join(folder, 'chatgpt.zip'); await writeFile(path, exportRelease(approved(files, policy), policy, 'chatgpt'));
    const [imported] = await importSkillFromPath(path);
    expect(imported.sourceFormat).toBe('chatgpt'); expect(imported.files.find(f => f.path === 'SKILL.md')?.content).toBe(files[0].content);
    expect(imported.files.some(f => f.path === 'imported-plugin/plugin.json')).toBe(true);
    expect(imported.files.some(f => f.path === 'references/check.md')).toBe(true); expect(imported.warnings.join(' ')).toContain('not installed');
  });
  it('preserves untrusted plugin-level configuration as inert companion files', async () => {
    const folder = await scratch(); const zip = new AdmZip(); zip.addFile('plugin/.codex-plugin/plugin.json', Buffer.from('{"name":"example","hooks":"./hooks/hooks.json"}'));
    zip.addFile('plugin/skills/monthly-workbook/SKILL.md', Buffer.from(clean()[0].content));
    zip.addFile('plugin/hooks/hooks.json', Buffer.from('{"description":"Untrusted demonstration hook metadata"}'));
    const path = join(folder, 'plugin.zip'); await writeFile(path, zip.toBuffer());
    const [imported] = await importSkillFromPath(path);
    expect(imported.files).toHaveLength(3); expect(imported.files.some(f => f.path === 'imported-plugin/hooks/hooks.json')).toBe(true);
  });
  it('enforces Claude upload metadata without silently rewriting approved bytes', () => {
    const files = clean(); files[0].content = files[0].content.replace('Reusable instructions imported for review.', 'A concise workflow. '.repeat(12));
    const record = approved(files); const policy = createDefaultPolicy();
    expect(() => exportRelease(record, policy, 'portable')).not.toThrow(); expect(() => exportRelease(record, policy, 'claude')).toThrow(/200 characters/);
    const reserved = clean(); reserved[0].content = reserved[0].content.replace('name: monthly-workbook', 'name: claude-workbook');
    expect(() => exportRelease(approved(reserved), policy, 'claude')).toThrow(/reserves/);
  });
  it('invalidates approval after any byte, path, exclusion, policy, or review change', () => {
    const policy = createDefaultPolicy();
    for (const alter of [
      (r: SkillRecord) => { r.versions[0].files[0].content += '\nChanged'; },
      (r: SkillRecord) => { r.versions[0].files[0].path = 'other.md'; },
      (r: SkillRecord) => { r.versions[0].files[0].excluded = true; },
      (r: SkillRecord) => { r.review!.id = 'replaced-review'; },
    ]) { const record = approved(); alter(record); expect(() => exportRelease(record, policy, 'portable')).toThrow(/changed|review|approve/i); }
    const record = approved(); policy.restrictedTerms.push('monthly'); expect(() => exportRelease(record, policy, 'portable')).toThrow(/policy changed/i);
  });
  it('rechecks current findings and requires a matching explained acknowledgment', () => {
    const files = clean(); files[0].content += '\nContact analyst@example.test'; const policy = createDefaultPolicy(); const record = approved(files, policy);
    expect(() => validateRelease(record, policy)).toThrow(/blocking/);
    record.review!.findings[0].status = 'resolved'; expect(() => validateRelease(record, policy)).toThrow(/blocking/);
    record.review!.findings[0].status = 'acknowledged'; record.review!.findings[0].resolutionNote = 'This is a fictional contact provided for the public example.';
    expect(() => validateRelease(record, policy)).not.toThrow();
    record.review!.findings = []; expect(() => validateRelease(record, policy)).toThrow(/blocking/);
  });
  it('refuses forged credential clearance, incomplete coverage, and wrong permission basis', () => {
    const files = clean(); files[0].content += '\npassword = fictionalSecret12345'; const record = approved(files); const policy = createDefaultPolicy();
    record.review!.findings.forEach(f => { f.status = 'acknowledged'; f.resolutionNote = 'Claimed safe'; });
    expect(() => validateRelease(record, policy)).toThrow(/blocking/);
    const binary = approved([...clean(), fileFromBytes('example.bin', Buffer.from([0]))]); expect(() => validateRelease(binary, policy)).toThrow(/coverage/);
    policy.requireEmployerPermission = true; const needsPermission = approved(clean(), policy); expect(() => validateRelease(needsPermission, policy)).toThrow(/employer permission/);
  });
  it('permits resolved model edit history while independently blocking active rule findings', () => {
    const record = approved(); const policy = createDefaultPolicy();
    record.review!.findings.push({ id: 'history', filePath: 'SKILL.md', startLine: 1, endLine: 1, source: 'model', severity: 'critical', category: 'credential', title: 'Removed credential', detail: 'A previous draft contained a credential.', excerpt: '[REMOVED_SECRET]', status: 'resolved' });
    expect(() => validateRelease(record, policy)).not.toThrow();
    const files = clean(); files[0].content += '\npassword = fictionalSecret12345';
    const forged = approved(files); forged.review!.findings.forEach(f => { f.source = 'model'; f.status = 'resolved'; });
    expect(() => validateRelease(forged, policy)).toThrow(/blocking/);
  });
});
