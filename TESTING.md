# Testing and evaluation

The package tests review behavior, trust boundaries, and controlled task outcomes. All bundled fixtures are synthetic. They contain no real employer documents, production financial figures, or usable credentials.

## Run the checks

Use Node.js 22 or newer, then run:

```sh
npm ci
npm test
npm run build
npm run benchmark
```

CI runs the tests, build, and deterministic benchmark on Node.js 22. These checks require no model download or provider API access. The public package excludes desktop-runtime tests that depend on Electron or the application's model manager.

## Core regression coverage

Tests cover bounded imports and archive attacks; path and encoding validation; full-package scanning and incomplete coverage; exact policy evidence; changes to reviewed content; forbidden acknowledgment overrides; authorship, license, and source-ancestry preservation; deterministic exports; and receipt tampering and signer trust.

Export tests inspect package structure and approved bytes. They do not authenticate into destination applications or establish that every supported application version accepts an exported package.

## Deterministic leakage benchmark

`npm run benchmark` calls `runLeakageBenchmark()`. It scans synthetic markers representing company identifiers, credentials, and contact details, applies rule suggestions, and checks that the markers disappeared while review remained complete and no blocking findings remained. The command exits unsuccessfully if one of these checks fails.

This is regression coverage for known patterns. It does not measure general confidentiality detection, model quality, or whether a cleaned skill still performs its task.

## Paired task evaluation

`runUsefulnessBenchmark()` compares original and cleaned skill packages on two controlled financial tasks. Checks cover stable account mapping, conversion from year-to-date values to monthly results, units, Excel date headers, formulas, and balance reconciliation.

For model-backed evaluation, the caller supplies an `EvaluationModel` implementing `runEvaluationTasks`. The built-in benchmark mode is named `local-ai`; the public package includes no inference runtime or provider client. The calling application is responsible for the adapter's execution environment and data handling.

The model receives each complete included text package and a controlled task specification. It returns a bounded declarative workbook plan. Trusted evaluator code computes the workbook and checks the results. Imported code, macros, external tools, and links are never executed. This does not run the original skill inside Excel or another agent application.

Reports bind both content hashes, policy hash, fixture and suite hashes, engine version, and model identity when a model ran. They record paired outcomes as retained, lost, improved, or failed on both sides. Changing the skill, policy, fixtures, or model changes the conditions of the comparison.

| Status | Meaning |
| --- | --- |
| `structural-only` | Package checks ran; model task performance was not tested. |
| `not-run` | Model evaluation was requested without a model adapter. |
| `complete` | Both sides of every task produced evaluable plans; individual checks may still fail. |
| `incomplete` | At least one task failed, was interrupted, or returned an invalid or unfinished plan. |

The suite is deliberately narrow. General model knowledge may compensate for missing skill instructions, so paired success cannot prove that cleanup preserved all useful behavior. If the original passes no checks, retention cannot be established. Leakage checks and task results do not establish ownership, permission, or confidentiality clearance. Benchmark results never approve a release or modify the skill.

## Contributions

Reproduce failures with minimal synthetic fixtures. Never include employer skill exports, private paths, production financial figures, or usable credentials in repository files, logs, issues, or pull requests. Do not remove attribution notices when adapting test material.

Add behavior-focused regression tests for changes to review or export boundaries. Report the commands run and relevant limitations. Keep structural, deterministic, and actual model-backed results distinct; do not describe unavailable or failed model execution as a passing test. See [SECURITY.md](SECURITY.md) for reporting security issues.
