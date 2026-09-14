import { z } from 'zod';

export interface FindingEvidence {
  kind: 'baseline' | 'policy'; policyId: string; policyVersion: number; policyHash: string;
  ruleId: string; clause: string; matchedTerm?: string;
}
export interface CleaningChange {
  filePath: string; startLine: number; endLine: number; before: string; after: string;
  reason: string; evidence: FindingEvidence[]; kind: 'edit' | 'exclude' | 'add' | 'remove';
}

const shortText = z.string().min(1).max(2000).refine(value => !!value.trim(), 'Text must not be blank.');
const resourcePath = z.string().min(1).max(240);
export const portabilityContractSchema = z.strictObject({
  schemaVersion: z.literal(1),
  purpose: shortText,
  inputs: z.array(z.strictObject({
    id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(64),
    label: shortText.max(120), kind: z.enum(['document', 'mapping', 'value']),
    required: z.boolean(), description: shortText,
  })).max(100),
  resources: z.array(z.strictObject({ path: resourcePath, role: z.enum(['method', 'configuration', 'input', 'license']) })).max(512),
  provenance: z.strictObject({
    origin: z.enum(['original', 'adapted', 'employer', 'unknown']),
    authors: z.array(shortText.max(200)).max(100),
    license: shortText.max(500),
    sourceUrl: z.string().max(2000).url().optional(),
    revision: shortText.max(200).optional(),
    noticePaths: z.array(resourcePath).max(100),
    modifications: z.string().min(1).max(8000).refine(value => !!value.trim(), 'Text must not be blank.').optional(),
  }),
});
export type PortabilityContract = z.infer<typeof portabilityContractSchema>;

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const receiptPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1), packageSha256: hash, contentHash: hash,
  policyHash: hash, policyId: z.string().min(1).max(200), policyVersion: z.number().int().min(1),
  reviewId: z.string().min(1).max(200), approvalTimestamp: z.string().datetime({ offset: true }),
  permissionBasis: z.enum(['own-work', 'employer-permission']), reviewer: z.string().min(1).max(200).optional(),
});
export type ReceiptPayload = z.infer<typeof receiptPayloadSchema>;
export const exportReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), payload: receiptPayloadSchema,
  signature: z.strictObject({ algorithm: z.literal('Ed25519'), publicKey: z.string().min(1).max(2000), value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/) }).optional(),
});
export type ExportReceipt = z.infer<typeof exportReceiptSchema>;
export interface ReceiptVerification {
  valid: boolean; packageMatches: boolean; signatureValid: boolean | null; signerTrusted: boolean;
  fingerprint?: string; errors: string[];
}
