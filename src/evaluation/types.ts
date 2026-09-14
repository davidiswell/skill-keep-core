import type { JobProgress, Policy, SkillFile } from '../shared/types';

export type BenchmarkStatus = 'not-run' | 'structural-only' | 'complete' | 'incomplete';
export interface BenchmarkCheck { id: string; label: string; passed: boolean; detail: string }
export interface WorkbookCell { value: string | number; formula?: string; format?: 'date' | 'currency' }
export interface EvaluatedWorkbook { name: string; rows: WorkbookCell[][] }
export interface BenchmarkSide {
  status: 'not-run' | 'complete' | 'incomplete';
  elapsedMs: number;
  checks: BenchmarkCheck[];
  warnings: string[];
  workbook?: EvaluatedWorkbook;
}
export interface FixtureComparison { fixtureId: string; fixtureHash: string; original: BenchmarkSide; cleaned: BenchmarkSide }
export interface LeakageResult { complete: boolean; blockingFindings: number; categories: string[]; warnings: string[] }
export interface BenchmarkReport {
  schemaVersion: 1; id: string; createdAt: string; status: BenchmarkStatus;
  suiteId: string; engineVersion: string; suiteHash: string; originalHash: string; cleanedHash: string; policyHash: string;
  modelId?: string; modelVersion?: string;
  structural: BenchmarkCheck[];
  leakage: { original: LeakageResult; cleaned: LeakageResult };
  comparisons: FixtureComparison[];
  retention: { retained: number; lost: number; improved: number; failedBoth: number; assessed: number; baselinePassed: number };
  warnings: string[];
}
export interface EvaluationTask { requestId: string; fixtureId: string; files: SkillFile[] }
export interface EvaluationTaskAnswer { requestId: string; content: string; finishReason: string; elapsedMs: number; error?: string }
export interface EvaluationModelResult { modelId: string; modelVersion: string; answers: EvaluationTaskAnswer[] }
export interface EvaluationModel {
  runEvaluationTasks(tasks: EvaluationTask[], options?: { signal?: AbortSignal; onProgress?: (event: JobProgress) => void }): Promise<EvaluationModelResult>;
}
export interface BenchmarkOptions {
  originalFiles: SkillFile[]; cleanedFiles: SkillFile[]; policy: Policy;
  mode: 'structural' | 'local-ai'; model?: EvaluationModel;
  signal?: AbortSignal; onProgress?: (event: JobProgress) => void;
}
export const TARGETS = ['revenue', 'cost', 'operating_expense', 'depreciation', 'assets', 'liabilities', 'equity'] as const;
export type Target = typeof TARGETS[number];
export interface FinancialFixture {
  id: string; name: string;
  periods: [string, string]; units: 'USD thousands' | 'USD';
  mapping: { accountKey: string; target: Target }[];
  statements: { date: string; basis: 'year-to-date'; lines: { accountKey: string; displayLabel: string; amount: number }[] }[];
  expected: { revenue: [number, number]; cost: [number, number]; operating_expense: [number, number]; depreciation: [number, number]; assets: [number, number]; liabilities: [number, number]; equity: [number, number] };
}
export interface WorkbookPlan {
  requestId: string; fixtureId: string; complete: boolean;
  mappings: { accountKey: string; target: Target }[];
  incomeBasis: 'monthly-from-ytd' | 'year-to-date';
  unitMultiplier: 1 | 1000 | 1000000;
  periodHeaders: 'excel-dates' | 'text';
  ebitdaFormula: 'revenue-cost-operating_expense' | 'revenue-cost' | 'revenue-cost-operating_expense-depreciation';
  balanceFormula: 'assets-liabilities-equity' | 'assets-liabilities' | 'none';
  flagImbalance: boolean;
}
