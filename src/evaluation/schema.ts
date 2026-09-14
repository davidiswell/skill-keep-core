import { z } from 'zod';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const text = z.string().max(2000);
export const benchmarkCheckSchema = z.object({ id: z.string().max(100), label: text, passed: z.boolean(), detail: text }).strict();
const cellSchema = z.object({ value: z.union([z.string().max(200), z.number().finite()]), formula: z.string().regex(/^[BC][2-9](?:-[BC][2-9]){1,3}$/).optional(), format: z.enum(['date', 'currency']).optional() }).strict();
const sideSchema = z.object({ status: z.enum(['not-run', 'complete', 'incomplete']), elapsedMs: z.number().nonnegative(), checks: z.array(benchmarkCheckSchema).max(20), warnings: z.array(text).max(20), workbook: z.object({ name: text, rows: z.array(z.array(cellSchema).max(3)).max(30) }).strict().optional() }).strict();
const leakageSchema = z.object({ complete: z.boolean(), blockingFindings: z.number().int().nonnegative(), categories: z.array(z.string().max(100)).max(20), warnings: z.array(text).max(100) }).strict();
export const benchmarkReportSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().max(100), createdAt: z.string().datetime(), status: z.enum(['not-run', 'structural-only', 'complete', 'incomplete']),
  suiteId: z.string().max(100), engineVersion: z.string().max(100), suiteHash: hash, originalHash: hash, cleanedHash: hash, policyHash: hash,
  modelId: z.string().max(200).optional(), modelVersion: z.string().max(500).optional(),
  structural: z.array(benchmarkCheckSchema).max(20), leakage: z.object({ original: leakageSchema, cleaned: leakageSchema }).strict(),
  comparisons: z.array(z.object({ fixtureId: z.string().max(100), fixtureHash: hash, original: sideSchema, cleaned: sideSchema }).strict()).max(4),
  retention: z.object({ retained: z.number().int().nonnegative(), lost: z.number().int().nonnegative(), improved: z.number().int().nonnegative(), failedBoth: z.number().int().nonnegative(), assessed: z.number().int().nonnegative(), baselinePassed: z.number().int().nonnegative() }).strict(),
  warnings: z.array(text).max(30),
}).strict();
