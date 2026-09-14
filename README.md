# Skill Keep Core

Build portable AI workflows while keeping private workplace context under review.

Skill Keep Core is an MIT-licensed Node.js library for importing skills, identifying sensitive content, preparing editable drafts, and exporting approved packages for Claude, ChatGPT, Codex, or other Agent Skills tools. It runs in your own process without accounts, telemetry, or a hosted inference client.

## Get started

Use Node.js 22 or newer:

```sh
git clone https://github.com/davidiswell/skill-keep-core.git
cd skill-keep-core
npm ci
npm run build
```

```js
import {
  importSkillFromText,
  createDefaultPolicy,
  scanFiles,
  applyRuleSuggestions,
} from './dist/index.js';

const skill = importSkillFromText(
  'Workbook checks',
  'Validate formulas and reconcile totals against user-supplied statements.',
);
const policy = createDefaultPolicy();
const review = scanFiles(skill.files, policy);
const draft = applyRuleSuggestions(skill.files, review.findings);
const draftReview = scanFiles(draft, policy);

console.log({ complete: draftReview.complete, findingCount: draftReview.findings.length });
```

The original files remain unchanged. Review the draft and record approval before calling `exportRelease`; a successful scan alone does not authorize export.

## What you can build

- **Skill import and review:** bounded folder and ZIP imports, supporting-file inventory, readable findings, and an inspectable baseline policy.
- **Policy-aware cleanup:** additional organization rules, exact clause evidence, suggested edits, and recorded differences between versions.
- **Portable workflow contracts:** reviewed `skillkeep.json` metadata describing purpose, destination inputs, resources, authorship, and license information.
- **Controlled exports:** approval bound to exact content and policy hashes, fresh export checks, preserved attribution notices, and deterministic ZIPs.
- **Verifiable receipts:** optional Ed25519-signed sidecars over exported package hashes, with independent checks for package integrity and trusted signing keys.
- **Workflow evaluation:** compare original and cleaned instructions through the evaluation interfaces. See [Testing and evaluation](TESTING.md) for methods and limitations.

## Integration boundaries

The core stays provider-neutral. Your application supplies storage, user review, approval records, and signing-key protection. Evaluation accepts a caller-provided `EvaluationModel`; the package includes no model weights, downloads, provider credentials, or inference transport.

The Skill Keep desktop application and its optional provider/API integration layer are separate from this package. Integrations must define their own data-disclosure and credential-handling controls. Imported instructions, scripts, macros, and links are never executed by the core.

Automated review cannot establish ownership, authenticate employer permission, or guarantee removal of every confidential detail. A valid signature establishes integrity under a signing key; trust in that key must come from an independent source.

## Development and license

Run `npm test` to check changes. The [testing guide](TESTING.md) covers benchmarks and contribution practices; [SECURITY.md](SECURITY.md) covers confidential reporting and integration safeguards.

Skill Keep Core is [MIT licensed](LICENSE). Dependencies retain their licenses in `THIRD-PARTY-NOTICES.txt`. The desktop application is separately licensed.
