import AdmZip from 'adm-zip';
import type { ExportTarget, Finding, Policy, SkillRecord, SkillVersion } from '../shared/types';
import { fileBytes, hashFiles, normalizeFiles } from './files';
import { readMetadata } from './importer';
import { hashPolicy } from './policy';
import { findingKey, scanFiles } from './scanner';
import { validateNoticePreservation } from './portability';

export function isBlockingFinding(finding: Finding): boolean {
  // Main records successful AI edits as resolved history bound to the rewritten draft hash.
  // Active deterministic findings are always regenerated below and cannot use this exception.
  if (finding.source === 'model' && finding.status === 'resolved') return false;
  // Critical findings cannot be overridden. A disappearance after a content edit clears them.
  if (finding.severity === 'critical' || finding.category === 'credential') return true;
  if (finding.severity !== 'high') return false;
  // Structure and opaque content cannot be made portable by an attestation.
  if (finding.category === 'quality' || finding.category === 'unsupported') return true;
  return finding.status !== 'acknowledged' || !finding.resolutionNote?.trim();
}

export function validateRelease(record: SkillRecord, policy: Policy): SkillVersion {
  if (record.archivedAt || record.status === 'archived') throw new Error('Restore this skill before exporting it.');
  const version = record.versions.find(v => v.id === record.currentVersionId);
  const approval = record.approval;
  const report = record.review;
  if (!version || !approval || !report) throw new Error('Review and approve the current draft before exporting.');
  const contentHash = hashFiles(version.files);
  const policyHash = hashPolicy(policy);
  if (version.contentHash !== contentHash || approval.versionId !== version.id || approval.contentHash !== contentHash || report.contentHash !== contentHash || approval.reviewId !== report.id) throw new Error('The skill changed after review or approval. Review and approve this exact version again.');
  if (!policy.active || approval.policyId !== policy.id || report.policyId !== policy.id || approval.policyVersion !== policy.version || report.policyVersion !== policy.version || approval.policyHash !== policyHash || report.policyHash !== policyHash) throw new Error('The policy changed or is inactive. Review and approve the skill with the current policy.');
  if (!approval.reviewer.trim() || !approval.notes.trim() || !['own-work', 'employer-permission'].includes(approval.permissionBasis)) throw new Error('Approval needs a reviewer and a recorded permission basis.');
  if (policy.requireEmployerPermission && approval.permissionBasis !== 'employer-permission') throw new Error('The selected policy requires employer permission before export.');
  if (!report.complete) throw new Error('Review coverage is incomplete. Exclude unsupported files and review the draft again.');
  const rescanned = scanFiles(version.files, policy);
  if (!rescanned.complete) throw new Error('Export stopped: some included files cannot be reviewed.');
  const reviewed = new Map(report.findings.map(f => [findingKey(f), f]));
  const matched = rescanned.findings.map(f => {
    const prior = reviewed.get(findingKey(f));
    return prior ? { ...f, status: prior.status, resolutionNote: prior.resolutionNote } : f;
  });
  if (matched.some(isBlockingFinding) || report.findings.some(isBlockingFinding)) throw new Error('Resolve blocking findings and approve the exact draft before exporting.');
  if (report.filesTotal !== rescanned.filesTotal || report.filesScanned !== rescanned.filesScanned) throw new Error('The review inventory does not match this package. Scan it again.');
  validateNoticePreservation(record, version.files);
  return version;
}

const installation: Record<ExportTarget, string> = {
  portable: 'This ZIP contains a standard Agent Skills folder. Extract it and follow the skill installation instructions for your chosen application. SKILL.md is the entry point; references and assets remain relative to it.',
  claude: 'This ZIP contains one standard skill folder with SKILL.md at its root. In Claude, open Customize > Skills, choose Create skill, then Upload a skill. Code execution and skills must be enabled for your account. For Claude Code, extract the skill folder into ~/.claude/skills/. Follow your organization’s installation policy.',
  chatgpt: 'This ZIP contains a skills-only Agent Plugins package: plugin.json plus skills/<name>/SKILL.md. Extract it, add the plugin folder to a local or organization marketplace, then install it through the Plugins Directory. Marketplace availability varies by surface and workspace policy. For standalone desktop use, extract the inner skill folder into ~/.agents/skills/. Attaching this ZIP to a chat does not install it. No connector, hook, account, or cloud service is added by this package.',
  codex: 'This ZIP contains a standard skill folder. Extract the inner skill folder into ~/.agents/skills/ for personal Codex use, or into .agents/skills/ in a project. Codex detects changes automatically; restart if the skill does not appear. Invoke it with $<skill-name>. Follow your organization’s installation policy.',
};

export function exportRelease(record: SkillRecord, policy: Policy, target: ExportTarget): Buffer {
  if (!(target in installation)) throw new Error('Choose a supported export destination.');
  const version = validateRelease(record, policy);
  const files = normalizeFiles(version.files).filter(f => !f.excluded);
  const root = files.find(f => f.path.toLowerCase() === 'skill.md');
  if (!root || root.encoding !== 'utf8') throw new Error('The release needs a readable SKILL.md.');
  const metadata = readMetadata(root.content);
  if (!metadata.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || metadata.name.length > 64) throw new Error('Fix the SKILL.md name before exporting.');
  if (target === 'claude') {
    if (/anthropic|claude/i.test(metadata.name)) throw new Error('Claude reserves the words anthropic and claude in skill names. Rename the skill, review, and approve the new draft before exporting.');
    if ((metadata.description?.length || 0) > 200) throw new Error('Claude’s custom-skill upload guide limits descriptions to 200 characters. Shorten the description, then review and approve the new draft.');
    if (/<\/?[A-Za-z][^>]*>/.test(metadata.description || '')) throw new Error('Remove XML or HTML tags from the description before exporting for Claude. Review and approve the edited draft.');
    if (files.reduce((total, file) => total + file.size, 0) >= 30_000_000) throw new Error('Claude skill uploads must be under 30 MB uncompressed. Reduce included resources, review, and approve the smaller draft.');
  }
  const zip = new AdmZip();
  // Never serialize display metadata, policy source text, findings, permission notes, or excluded files.
  const skillPrefix = target === 'chatgpt' ? `${metadata.name}/skills/${metadata.name}` : metadata.name;
  for (const file of files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) zip.addFile(`${skillPrefix}/${file.path}`, fileBytes(file));
  if (target === 'chatgpt') zip.addFile(`${metadata.name}/plugin.json`, Buffer.from(JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: metadata.name, description: metadata.description }, null, 2) + '\n'));
  zip.addZipComment(`Skill Keep portable skill. ${installation[target]} Skill contents preserve the approved included files. Any generated plugin metadata comes from the reviewed SKILL.md. Scanning is not legal clearance.`);
  // ZIP dates are local fields; construct a fixed local date to remain identical across time zones.
  for (const entry of zip.getEntries()) entry.header.time = new Date(2000, 0, 1, 0, 0, 0);
  return zip.toBuffer();
}
