import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/core/canonical';
import { generateKeyPairSync } from 'node:crypto';
import AdmZip from 'adm-zip';
import type { Policy, SkillFile, SkillRecord } from '../../src/shared/types';
import type { PortabilityContract } from '../../src/core/contracts';
import { applyRuleSuggestions, createDefaultPolicy, createExportReceipt, exportRelease, fileFromBytes, generateReceiptKeyPair, hashFiles, hashPolicy, importSkillFromText, parsePortabilityContract, publicKeyFingerprint, readPortabilityContract, scanFiles, summarizeChanges, validateNoticePreservation, validatePortabilityContract, validateRelease, verifyReceipt, writePortabilityContract } from '../../src/core';

const textFile = (path: string, content: string) => fileFromBytes(path, Buffer.from(content));
const clean = () => importSkillFromText('example-method', 'Apply reusable steps to documents supplied by the user.').files;
const contract = (): PortabilityContract => ({ schemaVersion: 1, purpose: 'Create a workbook from supplied financial statements.', inputs: [{ id: 'statements', label: 'Statements', kind: 'document', required: true, description: 'Documents supplied at the destination.' }], resources: [], provenance: { origin: 'original', authors: ['Example Author'], license: 'MIT', noticePaths: [] } });
function approved(files = clean(), policy = createDefaultPolicy(), original?: SkillFile[]): SkillRecord {
  const stamp = '2026-09-14T00:00:00.000Z', contentHash = hashFiles(files);
  const review = scanFiles(files, policy);
  for (const finding of review.findings) if (finding.severity === 'high' && !['quality', 'credential', 'unsupported'].includes(finding.category)) { finding.status = 'acknowledged'; finding.resolutionNote = 'Fictional fixture, created for this test; redistribution was reviewed.'; }
  const record: SkillRecord = { id: 'test-record', name: 'Private display title', description: 'Private display description', tags: ['private tag'], sourceFormat: 'agent-skills', createdAt: stamp, updatedAt: stamp, status: 'ready', versions: [], currentVersionId: 'current', review };
  if (original) record.versions.push({ id: 'original', kind: 'import', createdAt: stamp, files: original, contentHash: hashFiles(original), note: 'Original fixture.' });
  record.versions.push({ id: 'current', kind: 'draft', createdAt: stamp, files, contentHash, note: 'Private editing note' });
  record.approval = { versionId: 'current', contentHash, reviewer: 'Example Reviewer', permissionBasis: 'own-work', notes: 'Private permission note', approvedAt: stamp, policyId: policy.id, policyVersion: policy.version, policyHash: hashPolicy(policy), reviewId: review.id };
  return record;
}

describe('bounded deterministic signing representation', () => {
  it('sorts nested object keys while preserving array order and exact string values', () => {
    expect(canonicalJson({ z: [2, 1], a: { y: 'literal\ntext', x: false } })).toBe(canonicalJson({ a: { x: false, y: 'literal\ntext' }, z: [2, 1] }));
    expect(canonicalJson({ z: [2, 1] })).not.toBe(canonicalJson({ z: [1, 2] }));
    expect(canonicalJson({ text: 'é' })).not.toBe(canonicalJson({ text: 'e\u0301' }));
  });
  it('rejects ambiguous values, accessors, sparse arrays, and cycles', () => {
    for (const value of [undefined, { value: undefined }, Number.NaN, Infinity, new Date(), new Array(2)]) expect(() => canonicalJson(value)).toThrow();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => canonicalJson(cycle)).toThrow(/circular/);
    expect(() => canonicalJson({ get secret() { throw new Error('Getter must never run'); } })).toThrow(/accessor/);
    const accessorArray = [1]; Object.defineProperty(accessorArray, 0, { get() { throw new Error('Getter must never run'); } });
    expect(() => canonicalJson(accessorArray)).toThrow(/accessor/);
    const hidden = {}; Object.defineProperty(hidden, 'payload', { get() { throw new Error('Getter must never run'); } });
    expect(() => canonicalJson(hidden)).toThrow(/non-JSON/);
  });
  it('enforces size and depth limits for untrusted verification inputs', () => {
    expect(() => canonicalJson({ text: 'a'.repeat(2_000_001) })).toThrow(/too large/);
    let nested: unknown = null; for (let index = 0; index < 34; index++) nested = { nested };
    expect(() => canonicalJson(nested)).toThrow(/too complex/);
  });
});

describe('exact evidence links', () => {
  it('links every matching policy clause without attributing unrelated or allow rules', () => {
    const policy = createDefaultPolicy(); policy.id = 'example-policy'; policy.rules = [
      { id: 'clause-a', description: 'Example review', sourceClause: 'Review the phrase Example Deal before reuse.', terms: ['Example Deal'], action: 'review', category: 'company-data', enabled: true },
      { id: 'clause-b', description: 'Example removal', sourceClause: 'Remove EXAMPLE DEAL from redistributed materials.', terms: ['EXAMPLE DEAL'], action: 'remove', category: 'company-data', enabled: true },
      { id: 'unmatched', description: 'Other requirement', terms: ['Another Phrase'], action: 'remove', category: 'company-data', enabled: true },
      { id: 'allowed', description: 'Allowed example', terms: ['Example Deal'], action: 'allow', category: 'company-data', enabled: true },
    ]; policy.restrictedTerms = ['Example Deal'];
    const files = [...clean(), textFile('Example Deal notes.txt', 'Use Example Deal as the context.')];
    const review = scanFiles(files, policy);
    const phrase = review.findings.find(finding => finding.title === 'Policy requires removal of this phrase')!;
    expect(phrase.severity).toBe('critical');
    expect(phrase.evidence?.map(evidence => evidence.ruleId).sort()).toEqual(['clause-a', 'clause-b', 'restricted-terms']);
    expect(phrase.evidence?.find(evidence => evidence.ruleId === 'clause-b')).toEqual({ kind: 'policy', policyId: policy.id, policyVersion: policy.version, policyHash: hashPolicy(policy), ruleId: 'clause-b', clause: policy.rules[1].sourceClause, matchedTerm: 'EXAMPLE DEAL' });
    expect(review.findings.find(finding => finding.title === 'Restricted phrase in filename')?.evidence).toEqual(phrase.evidence);
  });
  it('links deterministic findings to shipped baseline clauses instead of claiming company-policy support', () => {
    const policy = createDefaultPolicy(); policy.id = 'example-company-profile'; policy.rules = [];
    const review = scanFiles([...clean(), textFile('notes.txt', 'Contact reader@example.test')], policy);
    expect(review.findings).toHaveLength(1);
    const evidence = review.findings[0].evidence![0], baseline = createDefaultPolicy();
    expect(evidence.kind).toBe('baseline'); expect(evidence.policyId).toBe(baseline.id);
    expect(evidence.policyHash).toBe(hashPolicy(baseline));
    expect(evidence.clause).toBe(baseline.rules.find(rule => rule.id === evidence.ruleId)?.sourceClause);
  });
  it('keeps identical manual requirements linked to both original clauses', () => {
    const policy = createDefaultPolicy(); policy.id = 'example-company-profile'; policy.rules = ['one', 'two'].map(id => ({ id, description: 'Review redistribution rights', sourceClause: 'Confirm rights to redistribute methods.', action: 'review', category: 'policy', enabled: true }));
    const findings = scanFiles(clean(), policy).findings;
    expect(findings).toHaveLength(1); expect(findings[0].evidence?.map(entry => entry.ruleId).sort()).toEqual(['one', 'two']);
  });
  it('does not reuse acknowledgment when rule evidence has been altered', () => {
    const policy = createDefaultPolicy(), files = [...clean(), textFile('contact.txt', 'reader@example.test')], record = approved(files, policy);
    record.review!.findings[0].evidence![0].ruleId = 'invented-company-approval';
    expect(() => validateRelease(record, policy)).toThrow(/blocking/);
  });
  it('does not duplicate unchanged baseline clauses in cloned company policies or trust a modified built-in ID', () => {
    const policy = createDefaultPolicy(); policy.id = 'example-cloned-policy'; policy.trust = 'user-configured';
    expect(scanFiles(clean(), policy).findings).toEqual([]);
    policy.rules[0].sourceClause = 'Review a new company-specific requirement.';
    const findings = scanFiles(clean(), policy).findings;
    expect(findings).toHaveLength(1); expect(findings[0].evidence![0]).toMatchObject({ kind: 'policy', ruleId: policy.rules[0].id, clause: policy.rules[0].sourceClause });
  });
});

describe('observed cleaning history', () => {
  it('records actual replacements and exact prior rule evidence while leaving original bytes intact', () => {
    const policy = createDefaultPolicy(), before = [...clean(), textFile('notes.txt', 'First line\nreader@example.test\nLast line\n')];
    const report = scanFiles(before, policy), after = applyRuleSuggestions(before, report.findings);
    const changes = summarizeChanges(before, after, report.findings, policy);
    expect(changes).toHaveLength(1); expect(changes[0]).toMatchObject({ filePath: 'notes.txt', startLine: 2, endLine: 2, kind: 'edit', before: 'reader@example.test\n', after: '[REVIEWER_EMAIL]\n', evidence: report.findings[0].evidence });
    expect(before[1].content).toContain('reader@example.test'); expect(summarizeChanges(before, before, report.findings, policy)).toEqual([]);
  });
  it('distinguishes file addition, exclusion, removal, and binary change without claiming binary cleansing', () => {
    const policy = createDefaultPolicy(), before = [...clean(), textFile('exclude.txt', 'Example notes'), textFile('remove.txt', 'Example removal'), fileFromBytes('asset.bin', Buffer.from([0, 1]))];
    const after = [before[0], { ...before[1], excluded: true }, fileFromBytes('asset.bin', Buffer.from([0, 2])), textFile('added.txt', 'Example addition')];
    const changes = summarizeChanges(before, after, [], policy);
    expect(changes.map(change => [change.filePath, change.kind])).toEqual([['added.txt', 'add'], ['asset.bin', 'edit'], ['exclude.txt', 'exclude'], ['remove.txt', 'remove']]);
    expect(changes[1]).toMatchObject({ before: '', after: '', evidence: [] }); expect(changes[1].reason).toContain('not displayed or cleared');
  });
  it('does not manufacture company-policy evidence from model assertions or unchanged source text', () => {
    const policy = createDefaultPolicy(), before = clean(), after = clean(); after[0].content += '\nAdditional example step.';
    const fabricated = { ...scanFiles([...before, textFile('note.txt', 'reader@example.test')], policy).findings[0], filePath: 'SKILL.md', source: 'model' as const, excerpt: before[0].content, title: 'Company authorizes this change', evidence: [{ kind: 'policy' as const, policyId: 'fake', policyVersion: 1, policyHash: '0'.repeat(64), ruleId: 'fake', clause: 'Fake approval.' }] };
    expect(summarizeChanges(before, after, [fabricated], policy).every(change => change.evidence.length === 0)).toBe(true);
  });
  it('bounds excerpts and explicitly identifies shortened whole-file comparisons', () => {
    const policy = createDefaultPolicy(), before = [...clean(), textFile('long.txt', 'a'.repeat(12000))], after = [...clean(), textFile('long.txt', 'b'.repeat(12000))];
    const changes = summarizeChanges(before, after, [], policy);
    expect(changes[0].before.length).toBeLessThanOrEqual(8000); expect(changes[0].reason).toContain('shortened');
  });
});

describe('reviewed portability and authorship contracts', () => {
  it('writes portable metadata as scanned bytes and includes only those exact bytes in exports', () => {
    const files = writePortabilityContract(clean(), contract()), policy = createDefaultPolicy();
    expect(readPortabilityContract(files)).toEqual(contract());
    const archive = new AdmZip(exportRelease(approved(files, policy), policy, 'portable'));
    expect(archive.readAsText('example-method/skillkeep.json')).toBe(files.find(file => file.path === 'skillkeep.json')?.content);
    const changed = contract(); changed.provenance.authors = ['reader@example.test'];
    const report = scanFiles(writePortabilityContract(clean(), changed), policy);
    expect(report.findings.some(finding => finding.filePath === 'skillkeep.json' && finding.category === 'identity')).toBe(true);
  });
  it('rejects unsupported fields, duplicate IDs, unsafe paths and non-web or credentialed source URLs', () => {
    expect(() => validatePortabilityContract({ ...contract(), employerApproved: true })).toThrow(/unsupported/);
    const duplicate = contract(); duplicate.inputs.push(duplicate.inputs[0]); expect(() => validatePortabilityContract(duplicate)).toThrow(/duplicate/);
    for (const path of ['../secret', 'C:\\secret', 'CON', 'references\\note.txt']) { const bad = contract(); bad.resources = [{ path, role: 'method' }]; expect(() => validatePortabilityContract(bad)).toThrow(); }
    for (const sourceUrl of ['file:///example.txt', 'https://user:pass@example.test/source']) { const bad = contract(); bad.provenance.sourceUrl = sourceUrl; expect(() => validatePortabilityContract(bad)).toThrow(); }
    expect(() => parsePortabilityContract(' '.repeat(262145))).toThrow(/256 KB/);
    expect(() => parsePortabilityContract(JSON.stringify(contract()).replace('"schemaVersion":1', '"schemaVersion":2,"schemaVersion":1'))).toThrow(/duplicate/);
  });
  it('blocks malformed contracts and missing declared resources even when a prior finding is acknowledged', () => {
    const specification = contract(); specification.resources = [{ path: 'references/method.txt', role: 'method' }];
    for (const files of [writePortabilityContract(clean(), specification), [...clean(), textFile('skillkeep.json', '{"schemaVersion":2}')]]) {
      const policy = createDefaultPolicy(), record = approved(files, policy);
      record.review!.findings.forEach(finding => { finding.status = 'acknowledged'; finding.resolutionNote = 'Attempted override.'; });
      expect(() => validateRelease(record, policy)).toThrow(/blocking/);
    }
  });
  it('preserves original known notices and declared authorship independently of fresh approval', () => {
    const specification = contract(); specification.provenance.origin = 'adapted'; specification.provenance.noticePaths = ['LICENSE.txt'];
    const original = writePortabilityContract([...clean(), textFile('LICENSE.txt', 'Copyright (c) 2024 Example Author\nPermission notice, fictional test text.')], specification);
    const policy = createDefaultPolicy(); expect(() => validateRelease(approved(original, policy, original), policy)).not.toThrow();
    for (const altered of [original.filter(file => file.path !== 'LICENSE.txt'), original.map(file => file.path === 'LICENSE.txt' ? { ...file, excluded: true } : file), original.map(file => file.path === 'LICENSE.txt' ? textFile(file.path, 'Edited notice') : file)]) {
      expect(() => validateNoticePreservation(approved(altered, policy, original), altered)).toThrow(/notice/);
    }
    const altered = contract(); altered.provenance.origin = 'original'; altered.provenance.authors = ['Different Author'];
    expect(() => validateNoticePreservation(approved(original, policy, original), writePortabilityContract(original, altered))).toThrow(/provenance/);
  });
  it('preserves initial and adopted source-baseline notices plus inline attribution', () => {
    const original = [...clean(), textFile('LICENSE', 'Example license text.')], baseline = [...original, textFile('NOTICE.md', 'Additional example source notice.')];
    const current = [...original], record = approved(current, createDefaultPolicy(), original);
    record.versions.splice(1, 0, { id: 'adopted-source', kind: 'source', createdAt: record.createdAt, files: baseline, contentHash: hashFiles(baseline), note: 'Fictional source upgrade.' });
    record.baselineVersionId = 'adopted-source';
    expect(() => validateNoticePreservation(record, current)).toThrow(/notice/);
    const attributed = clean(); attributed[0].content += '\nCopyright (c) 2024 Example Author\n';
    expect(() => validateNoticePreservation(approved(clean(), createDefaultPolicy(), attributed), clean())).toThrow(/inline/);
  });
  it('rejects dangling and non-source baseline references instead of skipping source notices', () => {
    const files = clean(), policy = createDefaultPolicy(), record = approved(files, policy, files);
    for (const baselineVersionId of ['missing-source', 'current', '']) {
      record.baselineVersionId = baselineVersionId;
      expect(() => validateNoticePreservation(record, files)).toThrow(/source revision reference is invalid/);
      expect(() => validateRelease(record, policy)).toThrow(/source revision reference is invalid/);
    }
  });
});

describe('signed export receipts', () => {
  it('exports deterministic bytes and signs exact approved package bytes with separate signer trust', () => {
    const policy = createDefaultPolicy(), record = approved(clean(), policy), keys = generateReceiptKeyPair();
    const zip = exportRelease(record, policy, 'portable'); expect(exportRelease(record, policy, 'portable')).toEqual(zip);
    const receipt = createExportReceipt(record, policy, zip, { privateKeyPem: keys.privateKeyPem });
    expect(verifyReceipt(receipt, zip)).toMatchObject({ valid: true, packageMatches: true, signatureValid: true, signerTrusted: false });
    expect(verifyReceipt(receipt, zip, keys.publicKeyPem)).toMatchObject({ valid: true, signatureValid: true, signerTrusted: true, fingerprint: keys.fingerprint });
    expect(publicKeyFingerprint(keys.publicKeyPem)).toBe(keys.fingerprint);
    expect(JSON.stringify(receipt)).not.toMatch(/Private|Example Reviewer|private tag|PRIVATE KEY/);
    expect(receipt.payload).toMatchObject({ contentHash: record.approval!.contentHash, policyHash: hashPolicy(policy), reviewId: record.review!.id });
  });
  it('detects tampered payloads, package bytes, signatures, and substituted keys', () => {
    const policy = createDefaultPolicy(), record = approved(), zip = exportRelease(record, policy, 'chatgpt'), keys = generateReceiptKeyPair();
    const receipt = createExportReceipt(record, policy, zip, { target: 'chatgpt', privateKeyPem: keys.privateKeyPem });
    const payloadChanged = structuredClone(receipt); payloadChanged.payload.permissionBasis = 'employer-permission';
    expect(verifyReceipt(payloadChanged, zip, keys.publicKeyPem)).toMatchObject({ valid: false, signatureValid: false, signerTrusted: false });
    const otherBytes = Buffer.from(zip); otherBytes[20] ^= 1; expect(verifyReceipt(receipt, otherBytes).packageMatches).toBe(false);
    const otherKey = generateReceiptKeyPair(), keyChanged = structuredClone(receipt); keyChanged.signature!.publicKey = otherKey.publicKeyPem;
    expect(verifyReceipt(keyChanged, zip).signatureValid).toBe(false);
    expect(verifyReceipt(receipt, zip, otherKey.publicKeyPem)).toMatchObject({ valid: true, signatureValid: true, signerTrusted: false });
    const extraField = { ...receipt, employerApproved: true }; expect(verifyReceipt(extraField, zip).valid).toBe(false);
  });
  it('keeps unsigned checks distinct and makes reviewer disclosure explicit', () => {
    const policy = createDefaultPolicy(), record = approved(), zip = exportRelease(record, policy, 'codex');
    const receipt = createExportReceipt(record, policy, zip);
    expect(receipt.signature).toBeUndefined(); expect(receipt.payload.reviewer).toBeUndefined();
    expect(verifyReceipt(receipt, zip)).toMatchObject({ valid: true, signatureValid: null, signerTrusted: false });
    expect(createExportReceipt(record, policy, zip, { includeReviewer: true }).payload.reviewer).toBe('Example Reviewer');
    expect(() => createExportReceipt(record, policy, Buffer.from('unrelated archive'))).toThrow(/does not match/);
  });
  it('rejects malformed keys and changed approvals without invoking attacker accessors', () => {
    const policy = createDefaultPolicy(), record = approved(), zip = exportRelease(record, policy, 'portable');
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
    expect(() => createExportReceipt(record, policy, zip, { privateKeyPem: rsa.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() })).toThrow(/Ed25519/);
    expect(verifyReceipt({ get payload() { throw new Error('Must not run'); } }, zip).valid).toBe(false);
    record.versions[0].files[0].content += '\nChanged after approval';
    expect(() => createExportReceipt(record, policy, zip)).toThrow(/changed/);
  });
});
