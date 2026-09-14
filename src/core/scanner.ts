import { randomUUID } from 'node:crypto';
import { posix } from 'node:path';
import type { Finding, FindingCategory, Policy, ReviewReport, Severity, SkillFile } from '../shared/types';
import { digest, hashFiles, normalizeFiles } from './files';
import { readMetadata } from './importer';
import { baselineEvidence, createDefaultPolicy, hashPolicy, policyRuleEvidence, restrictedTermEvidence } from './policy';
import type { FindingEvidence } from './contracts';
import { canonicalJson } from './canonical';
import { inspectPortability } from './portability';

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
const MAX_FINDINGS = 5000;
class ScanCapacityReached extends Error {}
export function findingKey(finding: Pick<Finding, 'filePath' | 'startLine' | 'endLine' | 'category' | 'severity' | 'title' | 'excerpt' | 'source'> & { evidence?: FindingEvidence[] }): string {
  return digest(canonicalJson([finding.filePath, finding.startLine, finding.endLine, finding.category, finding.severity, finding.title, finding.excerpt, finding.source, (finding.evidence || []).map(entry => digest(canonicalJson(entry))).sort()])).slice(0, 24);
}

export function scanFiles(input: SkillFile[], policy: Policy): ReviewReport {
  const files = normalizeFiles(input);
  const active = files.filter(f => !f.excluded);
  const findings: Finding[] = [];
  const selectedPolicyHash = hashPolicy(policy);
  const seenFindings = new Map<string, Finding>();
  const restrictedTerms = [...new Map([...policy.restrictedTerms, ...policy.rules.filter(rule => rule.enabled && rule.action !== 'allow').flatMap(rule => rule.terms || [])].filter(term => term.trim()).map(term => [term.toLowerCase(), term])).values()];
  const evidenceByTerm = new Map(restrictedTerms.map(term => [term, restrictedTermEvidence(policy, term, selectedPolicyHash)]));
  let capacityReached = false;
  let opaqueContent = false;
  const warnings = ['Rule-based review cannot establish ownership or guarantee removal of all company information. Review the entire draft before approving.'];
  const add = (path: string, line: number, category: FindingCategory, severity: Severity, title: string, detail: string, excerpt: string, suggestion?: string, endLine = line, evidence: FindingEvidence[] = [baselineEvidence(title)]): void => {
    const truncated = excerpt.length > 16000;
    const item: Finding = { id: '', filePath: path, startLine: line, endLine, category, severity, title, detail: detail.slice(0, 18000) + (truncated ? ' The displayed excerpt is shortened; inspect the entire passage in the file editor.' : ''), excerpt: excerpt.slice(0, 16000), source: 'rules', status: 'open', evidence, ...(suggestion !== undefined && !truncated ? { suggestion } : {}) };
    const identity = findingKey({ ...item, evidence: [] });
    const prior = seenFindings.get(identity);
    if (!prior) {
      if (findings.length >= MAX_FINDINGS) throw new ScanCapacityReached();
      seenFindings.set(identity, item); findings.push(item);
    } else {
      const merged = [...new Map([...(prior.evidence || []), ...evidence].map(entry => [canonicalJson(entry), entry])).values()];
      if (merged.length > 1000) throw new ScanCapacityReached();
      prior.evidence = merged;
    }
  };
  const root = active.find(f => f.path.toLowerCase() === 'skill.md');
  if (!root) add('SKILL.md', 1, 'quality', 'high', 'Missing SKILL.md', 'A portable skill must include a root SKILL.md. Add one before approving.', 'SKILL.md');
  if (root && root.path !== 'SKILL.md') add(root.path, 1, 'quality', 'high', 'Use the standard entry filename', 'Rename the root entry to exactly SKILL.md so applications can discover it consistently.', root.path);
  let filesScanned = 0;
  try {
  for (const file of active) {
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(file.path)) add(file.path, 1, 'identity', 'high', 'Contact details in filename', 'Rename this resource and update its references, or explain why the exact filename is permitted.', file.path);
    if (/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:ghp|github_pat)_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16})\b/.test(file.path)) add(file.path, 1, 'credential', 'critical', 'Possible credential in filename', 'Remove this credential from the filename and every reference before export.', file.path);
    if (file.encoding !== 'utf8') {
      add(file.path, 1, 'unsupported', 'high', 'Binary content has not been reviewed', 'Images, workbooks, PDFs, documents, archives, and other binary assets can contain hidden information. This version cannot clear them. Exclude this file before export.', file.path);
      continue;
    }
    const editableProse = /\.(md|txt|rst)$/i.test(file.path);
    const lines = file.content.split('\n');
    const oversizedLine = lines.findIndex(line => line.length > 32768);
    if (oversizedLine >= 0) {
      add(file.path, oversizedLine + 1, 'unsupported', 'high', 'A line exceeds the text review limit', 'This file contains a line longer than 32,768 characters, such as minified data or an encoded payload. Format it into readable lines, replace it with plain instructions, or exclude the file before review.', lines[oversizedLine]);
      continue;
    }
    if (/[\u200b-\u200f\u202a-\u202e\u2060-\u2069]/u.test(file.content)) add(file.path, 1, 'quality', 'high', 'Hidden text direction or separator characters', 'Invisible formatting characters can obscure identifiers and instructions. Review and remove them before exporting.', file.path);
    for (const match of file.content.matchAll(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g)) {
      const start = file.content.slice(0, match.index).split('\n').length;
      add(file.path, start, 'credential', 'critical', 'Private key block', 'Remove this entire key block from the portable draft. Credentials cannot be acknowledged.', match[0], editableProse ? '[REMOVED_SECRET]' : undefined, start + match[0].split('\n').length - 1);
    }
    for (const term of restrictedTerms) if (file.path.toLowerCase().includes(term.toLowerCase())) {
      const mustRemove = policy.rules.some(r => r.enabled && r.action === 'remove' && r.terms?.some(t => t.toLowerCase() === term.toLowerCase()));
      add(file.path, 1, 'policy', mustRemove ? 'critical' : 'high', 'Restricted phrase in filename', 'Rename this file and update every reference to remove restricted filename context, or record why the policy permits this filename.', file.path, undefined, 1, evidenceByTerm.get(term));
    }
    if (/\.(exe|dll|com|msi|bat|cmd|ps1|sh|py|js|ts|mjs|cjs|vbs|bas|xlsm|html|htm|svg)$/i.test(file.path)) add(file.path, 1, 'unsafe-instruction', 'high', 'Executable or active resource', 'Skill Keep reads this file as text and never executes it. Review the entire resource, its effects, and permission to redistribute it before acknowledging.', file.path);
    if (file.path.toLowerCase() === 'skill.md') {
      const metadata = readMetadata(file.content);
      if (metadata.error) add(file.path, 1, 'quality', 'high', 'Fix skill metadata', metadata.error, lines[0] || '(empty file)');
      else {
        if (!metadata.name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name) || metadata.name.length > 64) add(file.path, 2, 'quality', 'high', 'Use a portable skill name', 'The YAML name must be at most 64 lowercase letters, digits, and single hyphens, with no leading or trailing hyphen.', metadata.name || '(missing name)');
        if (!metadata.description || metadata.description.length > 1024) add(file.path, 3, 'quality', 'high', 'Add a skill description', 'The YAML description must explain when to use the skill and contain 1–1024 characters.', metadata.description || '(missing description)');
      }
    }
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].replace(/\r$/, '');
      const lineNo = index + 1;
      if (/\bdata:[^\s;,]+(?:;[^,\s]*)?;base64,/i.test(line) || /(?:^|[\s"':])(?:[A-Za-z0-9+/]{500,}={0,2})(?:$|[\s"',])/.test(line)) {
        opaqueContent = true;
        add(file.path, lineNo, 'unsupported', 'high', 'Embedded encoded content has not been reviewed', 'This passage may contain an embedded image, document, or encoded payload. Remove it or replace it with reviewed plain text before export. Encoded bytes are not cleared by a text scan.', line);
      }
      const matches = (pattern: RegExp, category: FindingCategory, severity: Severity, title: string, detail: string, replacement?: string): void => {
        for (const match of line.matchAll(pattern)) add(file.path, lineNo, category, severity, title, detail, match[0], editableProse ? replacement : undefined);
      };
      matches(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{16,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g, 'credential', 'critical', 'Possible access credential', 'Remove this credential from the draft. Credentials cannot be cleared by acknowledgment.', '[REMOVED_SECRET]');
      matches(/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*/g, 'credential', 'critical', 'Private key material', 'Remove the entire private key, including its body and end marker. Never carry private keys in a portable skill.');
      if (/\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd|secret[_ -]?key)\b["']?\s*[=:]/i.test(line)) {
        const secret = /\b(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|password|passwd|secret[_ -]?key)\b["']?\s*[=:]\s*["']?([^\s"',;}{]{5,})/ig;
        for (const match of line.matchAll(secret)) if (!/^(?:\[|<|\$\{|process\.env\.|os\.environ|YOUR_|EXAMPLE_|REDACTED|REMOVED_|None|null|false|true)/i.test(match[1])) add(file.path, lineNo, 'credential', 'critical', 'Possible embedded secret', 'Remove the value or replace it with an input supplied at the destination. Acknowledgment cannot clear credentials.', match[1], editableProse ? '[REMOVED_SECRET]' : undefined);
      }
      matches(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/ig, 'identity', 'high', 'Email identifies a person or organization', 'Replace personal or company contact details with a role or a destination-supplied value.', '[REVIEWER_EMAIL]');
      matches(/\b\d{3}-\d{2}-\d{4}\b/g, 'identity', 'critical', 'Possible personal identifier', 'Remove personal identifiers from portable instructions.', '[REMOVED_IDENTIFIER]');
      matches(/\b(?:\+?1[-. ]?)?\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g, 'identity', 'high', 'Possible phone number', 'Replace contact details with a destination-supplied role or input.', '[CONTACT_NUMBER]');
      matches(/\b[A-Z]:\\(?:[^\s<>"|?*]| (?!$))+/g, 'internal-path', 'high', 'Company or personal filesystem path', 'Replace the machine-specific location with an explicit input. Review the filename and surrounding context too.', '[INPUT_DIRECTORY]');
      matches(/\\\\[A-Za-z0-9._-]+\\[^\s<>"|?*]+/g, 'internal-path', 'high', 'Internal network location', 'Replace network shares and private server locations with destination-supplied inputs.', '[INPUT_DIRECTORY]');
      matches(/(?:\/(?:Users|home|mnt|Volumes)\/[^\s"'<>]+)/g, 'internal-path', 'high', 'Personal or internal filesystem path', 'Replace paths that identify a user, employer, or private environment.', '[INPUT_DIRECTORY]');
      matches(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:sharepoint\.com|corp|internal|local)(?:\/[^\s<>"')\]]*)?/ig, 'internal-path', 'high', 'Possible internal service', 'Remove tenant names and internal links or replace them with a destination-supplied input.', '[INTERNAL_RESOURCE]');
      matches(/(?:\$|€|£)\s*\d[\d,]*(?:\.\d+)?(?:\s*(?:million|billion|thousand|[mbk]\b))?/ig, 'company-data', 'high', 'Financial amount may identify a business or deal', 'Check whether this is an actual financial fact. Generalize to a supplied amount, or document why this exact value is public or synthetic.', '[AMOUNT]');
      matches(/\b\d+(?:\.\d+)?\s*%/g, 'company-data', 'medium', 'Percentage needs context review', 'Confirm whether this percentage is a generic calculation, a public example, or a confidential assumption.');
      if (/\b(?:confidential|non[- ]public|trade secret|proprietary|internal[- ]only|do not distribute|for internal use)\b/i.test(line)) add(file.path, lineNo, 'proprietary-method', 'high', 'Restricted or proprietary context', 'Removing names does not establish permission to reuse a method. Review this passage and the permission basis; generalize or remove it as needed.', line);
      if (/\b(?:ignore|override|disregard|bypass)\b.{0,60}\b(?:previous|system|safety|policy|scanner|instructions|cleansing|review)\b/i.test(line) || /\b(?:exfiltrate|upload secrets|disable (?:logging|security)|send (?:the |all )?(?:files|data|contents) to)\b/i.test(line)) add(file.path, lineNo, 'unsafe-instruction', 'high', 'Instruction attempts to change review or transmit data', 'Imported instructions cannot control Skill Keep. Inspect this passage before making it part of a reusable skill.', line);
      if (/\b(?:client|customer|employer|company|project|deal|transaction)\s*(?:name|code(?:name)?)?\s*[:=]\s*[^\[<{\s]/i.test(line)) add(file.path, lineNo, 'identity', 'high', 'Named business context', 'Check this context for organization, client, project, or deal identifiers. Replace it with a role or a supplied input.', line);
      for (const term of restrictedTerms) {
        const mustRemove = policy.rules.some(r => r.enabled && r.action === 'remove' && r.terms?.some(t => t.toLowerCase() === term.toLowerCase()));
        for (const match of line.matchAll(new RegExp(term.replace(ESCAPE, '\\$&'), 'ig'))) add(file.path, lineNo, 'policy', mustRemove ? 'critical' : 'high', mustRemove ? 'Policy requires removal of this phrase' : 'Restricted phrase from selected policy', 'The selected policy requires review or removal of this phrase. Check the source clause before resolving it.', match[0], editableProse ? '[GENERALIZED_CONTEXT]' : undefined, lineNo, evidenceByTerm.get(term));
      }
      // Inventory Markdown links plus common quoted resource paths. Do not fetch or open them.
      const links = [...line.matchAll(/!?\[[^\]]*\]\(([^\s)]+)(?:\s+["'][^)]*["'])?\)/g)].map(m => m[1]);
      const codePaths = [...line.matchAll(/[`"']((?:(?:\.\.?\/)?(?:references|scripts|assets|evals)\/)[^`"'\s]+)[`"']/g)].map(m => m[1]);
      for (const raw of new Set([...links, ...codePaths])) {
        if (raw.startsWith('#') || /^(?:mailto:|data:)/i.test(raw)) continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
          if (!/^(?:https?:|mailto:)/i.test(raw)) add(file.path, lineNo, 'dependency', 'high', 'Nonportable resource link', 'This resource uses a local or unsupported link scheme. Replace it with an included relative resource or explain a safe destination input.', raw);
          else add(file.path, lineNo, 'dependency', 'medium', 'External resource is outside this review', 'This link was not opened. Review its destination, permission, and portability. Remote content is not included or verified.', raw);
          continue;
        }
        let target: string;
        try { target = decodeURIComponent(raw.split(/[?#]/)[0]); } catch { target = raw; }
        const resolved = posix.normalize(posix.join(posix.dirname(file.path), target.replace(/\\/g, '/')));
        if (!active.some(f => f.path === resolved)) {
          if (active.some(f => f.path.toLowerCase() === resolved.toLowerCase())) add(file.path, lineNo, 'quality', 'high', 'Reference filename capitalization differs', 'Use the exact included filename in this reference. A case-only mismatch can break the skill on another computer.', raw);
          else add(file.path, lineNo, 'dependency', 'high', 'Referenced file is missing or excluded', 'Include and review this resource, remove the reference, or document how the user will provide it at the destination. An excluded file is never exported.', raw);
        }
      }
    }
    filesScanned++;
  }
  // A prose policy is visible, enforceable review work rather than silently ignored prompt text.
  const ruleRepresentation = (rule: Policy['rules'][number]): string => canonicalJson({ ...rule, terms: rule.terms || [], sourceClause: rule.sourceClause || '' });
  const builtins = new Set(createDefaultPolicy().rules.map(ruleRepresentation));
  for (const rule of policy.rules.filter(r => r.enabled && r.action !== 'allow' && !r.terms?.length && !builtins.has(ruleRepresentation(r)))) add(root?.path || 'SKILL.md', 1, 'policy', 'high', `Policy review: ${rule.description.slice(0, 120)}`, 'Review this source clause against the entire package and record a reason. Local rule matching cannot establish compliance with a prose requirement.', rule.sourceClause || rule.description, undefined, 1, [policyRuleEvidence(policy, rule, undefined, selectedPolicyHash)]);
  for (const issue of inspectPortability(files)) add(issue.filePath, 1, issue.blocking ? 'quality' : 'proprietary-method', 'high', issue.title, issue.detail, issue.excerpt);
  } catch (error) {
    if (!(error instanceof ScanCapacityReached)) throw error;
    capacityReached = true;
    warnings.push('This review reached the limit of 5,000 findings or 1,000 evidence links per finding. Coverage is incomplete. Resolve or remove the repeated content and scan again.');
  }
  if (policy.rules.some(r => r.enabled && r.action === 'allow') || policy.allowedTerms.length) warnings.push('Allowed terms and allow rules provide review context; they do not bypass the baseline scanner or clear credentials.');
  for (const finding of findings) {
    finding.evidence?.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
    finding.id = findingKey(finding);
  }
  const complete = !capacityReached && !opaqueContent && active.length > 0 && filesScanned === active.length;
  if (!complete) warnings.push('Coverage is incomplete. Exclude unsupported files before approval; review references to anything excluded.');
  return { id: randomUUID(), createdAt: new Date().toISOString(), policyId: policy.id, policyVersion: policy.version, policyHash: selectedPolicyHash, mode: 'rules', findings, filesScanned, filesTotal: active.length, complete, contentHash: hashFiles(files), warnings };
}

export function applyRuleSuggestions(input: SkillFile[], findings: Finding[]): SkillFile[] {
  const files = normalizeFiles(input);
  return normalizeFiles(files.map(file => {
    if (file.excluded || file.encoding !== 'utf8') return file;
    const applicable = findings.filter(f => f.filePath === file.path && f.suggestion !== undefined && f.excerpt && f.status !== 'acknowledged').sort((a, b) => b.startLine - a.startLine || b.excerpt.length - a.excerpt.length);
    const lines = file.content.split('\n');
    for (const finding of applicable) {
      const start = finding.startLine - 1;
      const count = finding.endLine - finding.startLine + 1;
      if (start < 0 || count < 1 || start + count > lines.length) continue;
      const chunk = lines.slice(start, start + count).join('\n');
      if (!chunk.includes(finding.excerpt)) continue;
      const replacement = chunk.split(finding.excerpt).join(finding.suggestion!);
      lines.splice(start, count, ...replacement.split('\n'));
    }
    return { ...file, content: lines.join('\n') };
  }));
}
