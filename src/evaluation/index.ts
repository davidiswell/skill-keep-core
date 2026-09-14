import { randomUUID } from 'node:crypto';
import { hashFiles, hashPolicy, normalizeFiles, scanFiles, isBlockingFinding, createDefaultPolicy, fileFromBytes, applyRuleSuggestions } from '../core';
import type { Policy, SkillFile } from '../shared/types';
import { BENCHMARK_ENGINE_VERSION, FINANCIAL_FIXTURES, fixtureHash, SUITE_HASH, SUITE_ID } from './fixtures';
import { evaluationMessages, parseWorkbookPlan } from './protocol';
import { evaluateWorkbookPlan } from './workbook';
import { benchmarkReportSchema } from './schema';
import type { BenchmarkOptions, BenchmarkReport, BenchmarkSide, EvaluationTask, LeakageResult } from './types';
export type * from './types';
export { benchmarkReportSchema } from './schema';
export { BENCHMARK_ENGINE_VERSION, FINANCIAL_FIXTURES, SUITE_HASH, SUITE_ID, syntheticSkillPair } from './fixtures';
export { evaluateWorkbookPlan, renderWorkbookXlsx } from './workbook';

function leakage(files: SkillFile[], policy: Policy): LeakageResult {
  const report = scanFiles(files, policy), findings = report.findings.filter(isBlockingFinding);
  return { complete: report.complete, blockingFindings: findings.length, categories: [...new Set(findings.map(finding => finding.category))], warnings: report.warnings.slice(0, 100).map(warning => warning.slice(0, 2000)) };
}
const emptySide = (): BenchmarkSide => ({ status: 'not-run', elapsedMs: 0, checks: [], warnings: [] });
export async function runUsefulnessBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const original = normalizeFiles(options.originalFiles), cleaned = normalizeFiles(options.cleanedFiles);
  const originalIncluded = original.filter(file => !file.excluded), cleanedIncluded = cleaned.filter(file => !file.excluded);
  const report: BenchmarkReport = {
    schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), status: 'structural-only', suiteId: SUITE_ID, engineVersion: BENCHMARK_ENGINE_VERSION, suiteHash: SUITE_HASH,
    originalHash: hashFiles(original), cleanedHash: hashFiles(cleaned), policyHash: hashPolicy(options.policy),
    structural: [
      { id: 'instructions', label: 'Included skill instructions are present', passed: cleanedIncluded.some(file => /(^|\/)SKILL\.md$/i.test(file.path) && file.encoding === 'utf8' && file.content.trim().length > 0), detail: 'This is a package-presence check, not a test of task usefulness.' },
      { id: 'resource-retention', label: 'Previously included resource paths remain available', passed: originalIncluded.every(file => cleanedIncluded.some(candidate => candidate.path === file.path)), detail: 'Missing or excluded resources require review; intentional removal may be appropriate.' },
      { id: 'text-coverage', label: 'Included files are text-readable', passed: cleanedIncluded.length > 0 && cleanedIncluded.every(file => file.encoding === 'utf8'), detail: 'Binary resources and script execution are outside this controlled financial-planning test.' },
    ], leakage: { original: leakage(original, options.policy), cleaned: leakage(cleaned, options.policy) },
    comparisons: FINANCIAL_FIXTURES.map(fixture => ({ fixtureId: fixture.id, fixtureHash: fixtureHash(fixture), original: emptySide(), cleaned: emptySide() })),
    retention: { retained: 0, lost: 0, improved: 0, failedBoth: 0, assessed: 0, baselinePassed: 0 },
    warnings: ['This financial-planning suite evaluates two synthetic tasks, not all possible skill behavior. Imported scripts, macros and external tools are never executed.', 'Rule leakage checks cannot establish that all confidential information was removed or that reuse is permitted.'],
  };
  if (options.mode === 'structural') {
    report.warnings.push('Usefulness was not model-tested. Structural checks cannot show that a cleaned skill still performs its task.');
    return benchmarkReportSchema.parse(report);
  }
  if (!options.model) {
    report.status = 'not-run'; report.warnings.push('A local model was not supplied. No task outcomes or retention score were inferred.');
    return benchmarkReportSchema.parse(report);
  }
  const tasks: EvaluationTask[] = [];
  for (const fixture of FINANCIAL_FIXTURES) for (const files of [original, cleaned]) tasks.push({ requestId: randomUUID(), fixtureId: fixture.id, files });
  try {
    // Validate both complete packages before invoking the model. Never silently truncate input.
    for (const task of tasks) evaluationMessages(task);
    options.signal?.throwIfAborted();
    const result = await options.model.runEvaluationTasks(tasks, { signal: options.signal, onProgress: options.onProgress });
    report.modelId = result.modelId; report.modelVersion = result.modelVersion;
    if (!result.modelId || !result.modelVersion || result.answers.length !== tasks.length || new Set(result.answers.map(answer => answer.requestId)).size !== tasks.length || result.answers.some(answer => !tasks.some(task => task.requestId === answer.requestId))) throw new Error('Benchmark response identities were incomplete.');
    for (let index = 0; index < tasks.length; index++) {
      const task = tasks[index], fixture = FINANCIAL_FIXTURES[Math.floor(index / 2)], side = index % 2 ? report.comparisons[Math.floor(index / 2)].cleaned : report.comparisons[Math.floor(index / 2)].original;
      const answer = result.answers.find(answer => answer.requestId === task.requestId)!;
      side.elapsedMs = Number.isFinite(answer.elapsedMs) && answer.elapsedMs >= 0 ? answer.elapsedMs : 0;
      try {
        if (answer.error || options.signal?.aborted) throw new Error('The task was interrupted.');
        const plan = parseWorkbookPlan(task, answer.content, answer.finishReason);
        const evaluated = evaluateWorkbookPlan(plan, fixture);
        side.status = 'complete'; side.checks = evaluated.checks; side.workbook = evaluated.workbook;
      } catch { side.status = 'incomplete'; side.warnings.push('The task failed, was interrupted, or returned an invalid or unfinished plan. No passing result was inferred.'); }
    }
    report.status = report.comparisons.every(pair => pair.original.status === 'complete' && pair.cleaned.status === 'complete') ? 'complete' : 'incomplete';
  } catch {
    report.status = 'incomplete';
    report.warnings.push(options.signal?.aborted ? 'The benchmark was cancelled. No overall usefulness result is available.' : 'The local benchmark could not finish. Check model availability and the text input limit; no overall usefulness result is available.');
    for (const pair of report.comparisons) for (const side of [pair.original, pair.cleaned]) if (side.status === 'not-run') side.status = 'incomplete';
  }
  for (const pair of report.comparisons) {
    if (pair.original.status !== 'complete' || pair.cleaned.status !== 'complete') continue;
    for (const originalCheck of pair.original.checks) {
      const cleanCheck = pair.cleaned.checks.find(check => check.id === originalCheck.id);
      if (!cleanCheck) continue;
      report.retention.assessed++;
      if (originalCheck.passed) report.retention.baselinePassed++;
      if (originalCheck.passed && cleanCheck.passed) report.retention.retained++;
      else if (originalCheck.passed) report.retention.lost++;
      else if (cleanCheck.passed) report.retention.improved++;
      else report.retention.failedBoth++;
    }
  }
  if (report.status === 'complete' && report.retention.baselinePassed === 0) report.warnings.push('The original skill passed no task checks. Retention cannot be established from this baseline.');
  report.warnings.push('The model receives the same controlled task specification on both sides. General model knowledge may mask missing skill instructions; paired success is evidence for these cases, not proof that cleanup caused no loss.');
  return benchmarkReportSchema.parse(report);
}

/** Regression canaries for deterministic cleanup. These are wholly fictional and never trigger a model. */
export function runLeakageBenchmark() {
  const policy = createDefaultPolicy(); policy.restrictedTerms = ['Meridian Sample Group', 'Project Paper Kite'];
  const cases = [
    { id: 'identity-canary', text: 'Client: Meridian Sample Group. Transaction: Project Paper Kite.', markers: ['Meridian Sample Group', 'Project Paper Kite'] },
    { id: 'credential-canary', text: 'api_key = "sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"', markers: ['sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'] },
    { id: 'contact-canary', text: 'Contact: reviewer@meridian-sample.invalid', markers: ['reviewer@meridian-sample.invalid'] },
  ];
  return { suiteId: 'deterministic-leakage-v1', cases: cases.map(item => {
    const files = [fileFromBytes('SKILL.md', Buffer.from(`---\nname: synthetic-check\ndescription: A fictional leakage regression fixture.\n---\n${item.text}\nKeep monthly formulas and reconciliation checks.\n`))];
    const before = scanFiles(files, policy), cleaned = applyRuleSuggestions(files, before.findings), after = scanFiles(cleaned, policy);
    return { id: item.id, detected: before.findings.some(isBlockingFinding), canariesRemoved: item.markers.every(marker => cleaned.every(file => !file.content.includes(marker))), reviewComplete: after.complete, remainingBlocking: after.findings.filter(isBlockingFinding).length };
  }) };
}
