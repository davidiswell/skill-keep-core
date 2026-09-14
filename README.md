# Skill Keep Core

Keep reusable AI workflow knowledge portable while reviewing and removing private employer context.

This MIT-licensed Node.js package contains Skill Keep's cleaning engine, inspectable baseline policy, portability and attribution contract, export receipt verification, and fictional financial benchmark. It has no account, telemetry, cloud inference, or Electron dependency. The Skill Keep desktop application is separately licensed and is not included.

Automated cleaning helps review content; it cannot prove ownership, establish employer permission, or guarantee that every confidential fact or method was removed. User-authored policies can add restrictions but cannot turn off baseline detectors. Imported skills and policy documents are data, never executable instructions for this engine.

## Run from source

Use Node.js 22 or newer.

```sh
npm ci
npm test
npm run build
npm run benchmark
```

```js
import { importSkillFromText, createDefaultPolicy, scanFiles, applyRuleSuggestions } from './dist/index.js';

const skill = importSkillFromText('Workbook checks', '# Workbook checks\nValidate the formulas after adding columns.');
const policy = createDefaultPolicy();
const review = scanFiles(skill.files, policy);
const draft = applyRuleSuggestions(skill.files, review.findings);
const freshReview = scanFiles(draft, policy);
console.log({ complete: freshReview.complete, findingCount: freshReview.findings.length });
```

`baseline-policy.json` records the default policy and `baseline-detectors.json` records the exact built-in detector requirements. Findings carry clause evidence, policy version/hash, and matched terms. `summarizeChanges` ties actual edits to observed findings without asserting that model intent is known.

## Portable workflows

The reviewed `skillkeep.json` file separates a reusable purpose, destination-supplied input descriptions, resource roles, and authorship/license provenance. It contains no input values. Resource declarations do not exempt content from scanning. Referenced files and required attribution must remain available; conflicts between privacy and redistribution rights require review. Declaring a license is not proof of ownership.

The export gate binds approval to exact files, review coverage, and selected policy. Every export rescans included content, preserves required notices, and produces deterministic ZIP bytes. Nothing in this API authorizes taking employer material.

## Export receipts

`createExportReceipt(record, policy, zip, options)` returns an optional sidecar over the exact ZIP hash and approval/policy references. It excludes source excerpts and approval notes. Reviewer identity is omitted unless explicitly requested. A receipt can be unsigned or signed with Ed25519.

`verifyReceipt(receipt, zip, trustedPublicKeyPem)` reports package match, signature validity, and whether the signer matches a separately supplied trusted key. An embedded key alone does not establish trust. A personal signature does not authenticate an employer, and even a valid employer signature would not itself settle legal rights.

## Benchmarks

`npm run benchmark` runs deterministic fictional leakage canaries. It does **not** claim to test task usefulness.

`runUsefulnessBenchmark` compares original and cleaned skills on two fictional financial tasks: stable account mapping, monthly conversion from YTD data, units, Excel date headers, formulas, and balance reconciliation. A caller-supplied **local** model adapter produces a bounded declarative plan. Trusted evaluator code computes the workbook and checks numeric results. No imported script, macro, link, or tool is executed.

Without a model adapter the report explicitly says `structural-only` or `not-run`. Model failures remain `incomplete`. The benchmark records both content hashes, fixture hashes, policy hash, model identity, and paired outcomes. General model knowledge can mask missing skill instructions; these two tasks are useful evidence, not a comprehensive certification. The package does not bundle or download model weights.

## Contributions and provenance

Use fictional fixtures only. Never submit employer documents, source skill exports, credentials, private paths, or production financial figures in issues, tests, logs, or pull requests. Run the tests and include relevant behavior checks for changes to review or export gates.

This implementation was independently written. MikeOSS's workflow composition, provenance records, and tamper-evident exports informed the design; no MikeOSS code was copied. See [MikeOSS](https://mikeoss.com/) and its [public repositories](https://github.com/open-legal-products).

Skill Keep code in this package uses the MIT license. Dependencies retain their own licenses and notices in `THIRD-PARTY-NOTICES.txt`. The desktop application, private vaults, model weights, runtime binaries, and employer material are outside this package.
