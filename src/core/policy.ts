import { randomUUID } from 'node:crypto';
import type { FindingCategory, Policy, PolicyRule } from '../shared/types';
import { digest } from './files';
import { baselineDetectorRules } from './baseline';
import type { FindingEvidence } from './contracts';

const CATEGORIES: FindingCategory[] = ['credential', 'identity', 'company-data', 'internal-path', 'proprietary-method', 'dependency', 'unsafe-instruction', 'unsupported', 'policy', 'quality'];
export const DEFAULT_POLICY_ID = 'skillkeep-default';

export function createDefaultPolicy(): Policy {
  return {
    id: DEFAULT_POLICY_ID, name: 'Skill Keep baseline', version: 2,
    description: 'Keep reusable methods. Review identities, business facts, private paths, credentials, dependencies, and potentially proprietary instructions. Scanning does not establish permission to take a skill.',
    restrictedTerms: [], allowedTerms: [], requireEmployerPermission: false,
    rules: [
      { id: 'baseline-secrets', description: 'Remove credentials and access tokens.', action: 'remove', category: 'credential', enabled: true },
      { id: 'baseline-context', description: 'Generalize company and transaction context without inventing replacement facts.', action: 'generalize', category: 'company-data', enabled: true },
      { id: 'baseline-permission', description: 'Review permission to reuse methods and supporting materials.', action: 'review', category: 'proprietary-method', enabled: true },
      ...baselineDetectorRules(),
    ],
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z', active: true, trust: 'default',
  };
}

export function baselineEvidence(title: string): FindingEvidence {
  const rule = SHIPPED_BASELINE.rules.find(rule => rule.description === title);
  if (!rule) throw new Error('A deterministic finding must identify its baseline detector.');
  return { kind: 'baseline', policyId: SHIPPED_BASELINE.id, policyVersion: SHIPPED_BASELINE.version, policyHash: SHIPPED_BASELINE_HASH, ruleId: rule.id, clause: rule.sourceClause || rule.description };
}
export function policyRuleEvidence(policy: Policy, rule: PolicyRule, matchedTerm?: string, policyHash = hashPolicy(policy)): FindingEvidence {
  return { kind: 'policy', policyId: policy.id, policyVersion: policy.version, policyHash, ruleId: rule.id, clause: rule.sourceClause || rule.description, ...(matchedTerm !== undefined ? { matchedTerm } : {}) };
}
export function restrictedTermEvidence(policy: Policy, term: string, policyHash = hashPolicy(policy)): FindingEvidence[] {
  const evidence = policy.rules.filter(rule => rule.enabled && rule.action !== 'allow' && rule.terms?.some(value => value.toLowerCase() === term.toLowerCase())).map(rule => policyRuleEvidence(policy, rule, rule.terms!.find(value => value.toLowerCase() === term.toLowerCase()), policyHash));
  const restricted = policy.restrictedTerms.find(value => value.toLowerCase() === term.toLowerCase());
  if (restricted !== undefined) evidence.unshift({ kind: 'policy', policyId: policy.id, policyVersion: policy.version, policyHash, ruleId: 'restricted-terms', clause: `Restricted terms entry: ${JSON.stringify(restricted)}`, matchedTerm: restricted });
  return evidence;
}

export function hashPolicy(policy: Policy): string {
  // Activation and timestamps are UI state; every substantive rule and source clause is bound.
  return digest(JSON.stringify({ id: policy.id, version: policy.version, name: policy.name, organization: policy.organization || '', description: policy.description, restrictedTerms: [...policy.restrictedTerms].sort(), allowedTerms: [...policy.allowedTerms].sort(), requireEmployerPermission: policy.requireEmployerPermission, ...(policy.allowApiProcessing!==undefined?{allowApiProcessing:policy.allowApiProcessing}:{}), rules: [...policy.rules].sort((a, b) => a.id.localeCompare(b.id)).map(r => ({ id: r.id, description: r.description, action: r.action, category: r.category, terms: [...(r.terms || [])].sort(), sourceClause: r.sourceClause || '', enabled: r.enabled })), sourceText: policy.sourceText || '', trust: policy.trust }));
}
const SHIPPED_BASELINE = createDefaultPolicy();
const SHIPPED_BASELINE_HASH = hashPolicy(SHIPPED_BASELINE);

function strings(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500 || value.some(t => typeof t !== 'string' || !t.trim() || t.length > 300)) throw new Error(`${field} must contain at most 500 short, nonempty phrases.`);
  return [...new Set(value.map(t => t.trim()))];
}

export function parsePolicyDocument(text: string, filename: string): Policy {
  if (!text.trim() || Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Choose a policy containing text, no larger than 2 MB.');
  const now = new Date().toISOString();
  const policy: Policy = { id: randomUUID(), name: 'Imported policy', version: 1, description: 'Review these proposed rules, then activate the policy. This local profile does not authenticate employer permission.', restrictedTerms: [], allowedTerms: [], rules: [], requireEmployerPermission: true, sourceText: text, sourceFilename: filename.split(/[\\/]/).at(-1)?.slice(0, 240), createdAt: now, updatedAt: now, active: false, trust: 'user-configured' };
  if (/\.json$/i.test(filename) || text.trimStart().startsWith('{')) {
    let data: Record<string, unknown>;
    try { data = JSON.parse(text); } catch { throw new Error('The policy JSON could not be read. Check its formatting.'); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('A policy JSON document must contain an object.');
    if (typeof data.name === 'string') policy.name = data.name.trim().slice(0, 120) || policy.name;
    if (typeof data.organization === 'string') policy.organization = data.organization.trim().slice(0, 120);
    if (typeof data.description === 'string') policy.description = data.description.slice(0, 4000);
    policy.restrictedTerms = strings(data.restrictedTerms, 'Restricted terms');
    policy.allowedTerms = strings(data.allowedTerms, 'Allowed terms');
    if (typeof data.requireEmployerPermission === 'boolean') policy.requireEmployerPermission = data.requireEmployerPermission;
    if (typeof data.allowApiProcessing === 'boolean') policy.allowApiProcessing = data.allowApiProcessing;
    if (data.rules !== undefined) {
      if (!Array.isArray(data.rules) || data.rules.length > 100) throw new Error('A policy may contain at most 100 rules.');
      policy.rules = data.rules.map((raw: unknown, i: number): PolicyRule => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Each policy rule must be an object.');
        const rule = raw as Record<string, unknown>;
        if (typeof rule.description !== 'string' || !rule.description.trim() || rule.description.length > 4000 || !CATEGORIES.includes(rule.category as FindingCategory) || !['remove', 'generalize', 'review', 'allow'].includes(rule.action as string)) throw new Error('Each rule needs a description, a supported category, and an action (remove, generalize, review, or allow).');
        return { id: `imported-rule-${i + 1}`, description: rule.description, action: rule.action as PolicyRule['action'], category: rule.category as FindingCategory, terms: strings(rule.terms, 'Rule terms'), sourceClause: typeof rule.sourceClause === 'string' ? rule.sourceClause.slice(0, 8000) : rule.description, enabled: rule.enabled !== false };
      });
    }
  } else {
    const firstHeading = text.split(/\r?\n/).find(line => line.trim().length > 3);
    policy.name = (firstHeading || 'Imported policy').replace(/^#+\s*/, '').trim().slice(0, 100);
    // Prose clauses remain explicit review requirements. An LLM is never granted authority to activate them.
    const clauses = text.split(/\n\s*\n/).map(t => t.trim()).filter(Boolean).flatMap(clause => {
      const chunks: string[] = [];
      for (let start = 0; start < clause.length; start += 16000) chunks.push(clause.slice(start, start + 16000));
      return chunks;
    });
    if (clauses.length > 100) throw new Error('This policy has more than 100 sections. Import a focused policy or a structured JSON profile.');
    policy.rules = clauses.map((clause, i) => ({ id: `source-clause-${i + 1}`, description: `Review source clause ${i + 1}: ${clause.slice(0, 300)}`, action: 'review', category: 'policy', sourceClause: clause, enabled: true }));
  }
  return policy;
}
