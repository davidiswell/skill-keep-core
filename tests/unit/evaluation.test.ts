import { describe, expect, it, vi } from 'vitest';
import AdmZip from 'adm-zip';
import { createDefaultPolicy, fileFromBytes, hashFiles } from '../../src/core';
import { BENCHMARK_ENGINE_VERSION, FINANCIAL_FIXTURES, runUsefulnessBenchmark, runLeakageBenchmark, syntheticSkillPair, evaluateWorkbookPlan, renderWorkbookXlsx, benchmarkReportSchema } from '../../src/evaluation';
import { createHash } from 'node:crypto';
import { evaluationMessages, parseWorkbookPlan, MAX_EVALUATION_BYTES } from '../../src/evaluation/protocol';
import type { EvaluationModel, EvaluationTask, WorkbookPlan } from '../../src/evaluation/types';
import { LocalAiManager } from '../../src/local-ai';

function plan(task: Pick<EvaluationTask, 'requestId' | 'fixtureId'>): WorkbookPlan {
  const fixture = FINANCIAL_FIXTURES.find(item => item.id === task.fixtureId)!;
  return { requestId: task.requestId, fixtureId: fixture.id, complete: true, mappings: structuredClone(fixture.mapping), incomeBasis: 'monthly-from-ytd', unitMultiplier: fixture.units === 'USD thousands' ? 1000 : 1, periodHeaders: 'excel-dates', ebitdaFormula: 'revenue-cost-operating_expense', balanceFormula: 'assets-liabilities-equity', flagImbalance: true };
}
const task = (fixtureId = FINANCIAL_FIXTURES[0].id): EvaluationTask => ({ requestId: 'test-request', fixtureId, files: syntheticSkillPair().originalFiles });
function model(transform: (answer: WorkbookPlan, index: number) => unknown = answer => answer): EvaluationModel {
  return { runEvaluationTasks: vi.fn(async (tasks: EvaluationTask[]) => ({ modelId: 'controlled-test-model', modelVersion: 'test-fixture-only', answers: tasks.map((item, index) => ({ requestId: item.requestId, content: JSON.stringify(transform(plan(item), index)), finishReason: 'stop', elapsedMs: 1 })) })) };
}
const options = () => ({ ...syntheticSkillPair(), policy: createDefaultPolicy() });

describe('trusted financial workbook arithmetic', () => {
  it('renders calculated monthly values, actual dates, formulas and a visible real imbalance', () => {
    const fixture = FINANCIAL_FIXTURES[0], result = evaluateWorkbookPlan(plan(task()), fixture);
    expect(result.checks.every(check => check.passed)).toBe(true);
    expect(result.workbook.rows[1][2].value).toBe(155000);
    expect(result.workbook.rows[5][1]).toMatchObject({ value: 55000, formula: 'B2-B3-B4' });
    expect(result.workbook.rows[5][2]).toMatchObject({ value: 75000, formula: 'C2-C3-C4' });
    expect(result.workbook.rows[0][1]).toMatchObject({ value: 45688, format: 'date' });
    const unbalanced = evaluateWorkbookPlan(plan(task(FINANCIAL_FIXTURES[1].id)), FINANCIAL_FIXTURES[1]);
    expect(unbalanced.checks.every(check => check.passed)).toBe(true);
    expect(unbalanced.workbook.rows[9][2]).toMatchObject({ value: 500, formula: 'C7-C8-C9' });
    expect(unbalanced.workbook.rows[10][2].value).toBe(1);
    const zip = new AdmZip(renderWorkbookXlsx(result.workbook));
    expect(zip.getEntries().map(entry => entry.entryName)).toHaveLength(6);
    expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('<f>C2-C3-C4</f><v>75000</v>');
    expect(zip.readAsText('xl/worksheets/sheet1.xml')).toContain('s="1"><v>45688</v>');
    expect(zip.getEntries().some(entry => /external|vba|macro/i.test(entry.entryName))).toBe(false);
  });
  it('fails numeric and formula checks for YTD values, wrong units, omitted expenses and hidden imbalance', () => {
    const fixture = FINANCIAL_FIXTURES[1], wrong = { ...plan(task(fixture.id)), incomeBasis: 'year-to-date' as const, unitMultiplier: 1000 as const, periodHeaders: 'text' as const, ebitdaFormula: 'revenue-cost' as const, balanceFormula: 'none' as const, flagImbalance: false };
    const result = evaluateWorkbookPlan(wrong, fixture);
    expect(result.checks.filter(check => !check.passed).map(check => check.id)).toEqual(expect.arrayContaining(['units', 'monthly-income', 'date-cells', 'ebitda', 'reconciliation', 'imbalance-flag']));
    const swapped = plan(task());
    [swapped.mappings[0].accountKey, swapped.mappings[1].accountKey] = [swapped.mappings[1].accountKey, swapped.mappings[0].accountKey];
    expect(evaluateWorkbookPlan(swapped, FINANCIAL_FIXTURES[0]).checks.find(check => check.id === 'stable-mapping')?.passed).toBe(false);
  });
  it('rejects arbitrary formulas and renders formula-like text only as inert inline text', () => {
    const workbook = evaluateWorkbookPlan(plan(task()), FINANCIAL_FIXTURES[0]).workbook;
    workbook.rows[1][1].formula = 'WEBSERVICE("https://example.invalid")';
    expect(() => renderWorkbookXlsx(workbook)).toThrow('trusted');
    delete workbook.rows[1][1].formula;
    workbook.rows[0][0].value = '=HYPERLINK("https://example.invalid")';
    const sheet = new AdmZip(renderWorkbookXlsx(workbook)).readAsText('xl/worksheets/sheet1.xml');
    expect(sheet).toContain('t="inlineStr"><is><t>=HYPERLINK');
    expect(sheet).not.toContain('<f>HYPERLINK');
  });
});

describe('bounded untrusted model protocol', () => {
  it('rejects truncated, incomplete, extra-field, wrong-identity and duplicate-account answers', () => {
    const request = task(), correct = plan(request);
    expect(() => parseWorkbookPlan(request, JSON.stringify(correct), 'length')).toThrow('finish');
    for (const value of [{ ...correct, complete: false }, { ...correct, requestId: 'another-request' }, { ...correct, command: 'run a shell' }, { ...correct, mappings: correct.mappings.map(() => correct.mappings[0]) }]) {
      expect(() => parseWorkbookPlan(request, JSON.stringify(value), 'stop')).toThrow();
    }
  });
  it('provides complete reference data without expected answers and rejects oversized or binary packages', () => {
    const request = task(), messages = evaluationMessages(request);
    expect(messages[0].content).toContain('UNTRUSTED REFERENCE DATA');
    expect(JSON.parse(messages[1].content).syntheticInputs).not.toHaveProperty('expected');
    expect(() => evaluationMessages({ ...request, files: [fileFromBytes('SKILL.md', Buffer.from('x'.repeat(MAX_EVALUATION_BYTES + 1)))] })).toThrow('No partial');
    expect(() => evaluationMessages({ ...request, files: [{ path: 'asset.bin', content: 'AA==', encoding: 'base64', size: 1, sha256: '0'.repeat(64) }] })).toThrow('binary');
  });
});

describe('managed evaluation lifecycle without native execution', () => {
  function managed() {
    const manager = new LocalAiManager({ directory: 'fictional-test-model-directory' });
    const internals = manager as unknown as { initialize(): Promise<void>; startWorker(signal?: AbortSignal): Promise<void>; stopWorker(): Promise<void>; complete(...args: unknown[]): Promise<{ content: string; finishReason: string }> };
    vi.spyOn(internals, 'initialize').mockResolvedValue();
    const start = vi.spyOn(internals, 'startWorker').mockResolvedValue();
    const stop = vi.spyOn(internals, 'stopWorker').mockResolvedValue();
    const complete = vi.spyOn(internals, 'complete').mockResolvedValue({ content: JSON.stringify(plan(task())), finishReason: 'stop' });
    return { manager, start, stop, complete };
  }
  it('uses the bounded fixed task protocol and releases the worker after a batch', async () => {
    const fixture = managed();
    const result = await fixture.manager.runEvaluationTasks([task()]);
    expect(result.answers[0].requestId).toBe('test-request'); expect(result.modelVersion).toContain('b10964');
    expect(fixture.complete.mock.calls[0][3]).toBe(1500); expect(fixture.complete.mock.calls[0][4]).toBe(180000);
    expect(fixture.stop).toHaveBeenCalledOnce();
    await expect(fixture.manager.runEvaluationTasks(Array.from({ length: 5 }, (_, index) => ({ ...task(), requestId: `test-${index}` })))).rejects.toThrow('batch');
    expect(fixture.start).toHaveBeenCalledOnce();
  });
  it('retains attempted model identity and marks every task failed when worker loading fails', async () => {
    const fixture = managed(); fixture.start.mockRejectedValue(new Error('simulated native startup failure'));
    const result = await fixture.manager.runEvaluationTasks([task()]);
    expect(result.modelId).toBeTruthy(); expect(result.modelVersion).toBeTruthy(); expect(result.answers[0].error).toBeTruthy();
    expect(result.answers[0].finishReason).not.toBe('stop'); expect(fixture.complete).not.toHaveBeenCalled(); expect(fixture.stop).toHaveBeenCalledOnce();
  });
});

describe('paired usefulness report integrity', () => {
  it('reports structural-only and absent-model states without invented task passes', async () => {
    const structural = await runUsefulnessBenchmark({ ...options(), mode: 'structural' });
    expect(structural.status).toBe('structural-only'); expect(structural.retention.assessed).toBe(0);
    expect(structural.comparisons.every(pair => pair.original.status === 'not-run')).toBe(true);
    const notRun = await runUsefulnessBenchmark({ ...options(), mode: 'local-ai' });
    expect(notRun.status).toBe('not-run'); expect(notRun.modelId).toBeUndefined();
  });
  it('records paired hashes and measured retained checks from controlled task responses', async () => {
    const input = options(), result = await runUsefulnessBenchmark({ ...input, mode: 'local-ai', model: model() });
    expect(result.status).toBe('complete'); expect(result.retention).toMatchObject({ retained: 16, lost: 0, assessed: 16, baselinePassed: 16 });
    expect(result.originalHash).toBe(hashFiles(input.originalFiles)); expect(result.cleanedHash).toBe(hashFiles(input.cleanedFiles));
    expect(result.originalHash).not.toBe(result.cleanedHash); expect(result.modelVersion).toBe('test-fixture-only');
    expect(result.engineVersion).toBe(BENCHMARK_ENGINE_VERSION);
    expect(result.suiteHash).toBe(createHash('sha256').update(JSON.stringify({ engineVersion: BENCHMARK_ENGINE_VERSION, fixtures: FINANCIAL_FIXTURES })).digest('hex'));
    expect(benchmarkReportSchema.parse(result)).toEqual(result);
  });
  it('detects usefulness loss even when every expected financial keyword remains in the skill', async () => {
    const controlled = model((answer, index) => index % 2 ? { ...answer, incomeBasis: 'year-to-date', ebitdaFormula: 'revenue-cost', flagImbalance: false } : answer);
    const result = await runUsefulnessBenchmark({ ...options(), mode: 'local-ai', model: controlled });
    expect(result.status).toBe('complete'); expect(result.retention.lost).toBeGreaterThanOrEqual(6);
    expect(result.comparisons[0].cleaned.checks.find(check => check.id === 'monthly-income')?.passed).toBe(false);
  });
  it('keeps model failure and cancellation incomplete with no invented retention', async () => {
    const failure: EvaluationModel = { runEvaluationTasks: async () => { throw new Error('private diagnostic must not enter evidence'); } };
    const result = await runUsefulnessBenchmark({ ...options(), mode: 'local-ai', model: failure });
    expect(result.status).toBe('incomplete'); expect(result.retention.assessed).toBe(0); expect(JSON.stringify(result)).not.toContain('private diagnostic');
    const controller = new AbortController(); controller.abort();
    const never = model(); const cancelled = await runUsefulnessBenchmark({ ...options(), mode: 'local-ai', model: never, signal: controller.signal });
    expect(cancelled.status).toBe('incomplete'); expect(never.runEvaluationTasks).not.toHaveBeenCalled();
  });
  it('marks malformed sides incomplete and excludes their entire pair from retention counts', async () => {
    const result = await runUsefulnessBenchmark({ ...options(), mode: 'local-ai', model: model((answer, index) => index === 1 ? { ...answer, complete: false } : answer) });
    expect(result.status).toBe('incomplete'); expect(result.comparisons[0].cleaned.status).toBe('incomplete');
    expect(result.retention.assessed).toBe(8); expect(result.retention.retained).toBe(8);
  });
  it('never executes imported scripts and does not silently evaluate oversized packages', async () => {
    const input = options(); input.cleanedFiles.push(fileFromBytes('scripts/do-not-run.js', Buffer.from('throw new Error("IMPORTED_SCRIPT_EXECUTED");')));
    expect((await runUsefulnessBenchmark({ ...input, mode: 'local-ai', model: model() })).status).toBe('complete');
    const never = model(); input.cleanedFiles.push(fileFromBytes('references/large.md', Buffer.from('x'.repeat(MAX_EVALUATION_BYTES))));
    expect((await runUsefulnessBenchmark({ ...input, mode: 'local-ai', model: never })).status).toBe('incomplete');
    expect(never.runEvaluationTasks).not.toHaveBeenCalled();
  });
  it('runs deterministic leakage canaries without a model', () => {
    const result = runLeakageBenchmark();
    expect(result.cases).toHaveLength(3);
    expect(result.cases.every(item => item.detected && item.canariesRemoved && item.reviewComplete && item.remainingBlocking === 0)).toBe(true);
  });
});
