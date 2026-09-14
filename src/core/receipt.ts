import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import type { ExportTarget, Policy, SkillRecord } from '../shared/types';
import { exportReceiptSchema, receiptPayloadSchema, type ExportReceipt, type ReceiptPayload, type ReceiptVerification } from './contracts';
import { canonicalJson } from './canonical';
import { digest, LIMITS } from './files';
import { exportRelease, validateRelease } from './exporter';
import { hashPolicy } from './policy';

const SIGNING_DOMAIN = 'Skill Keep export receipt v1\n';
function publicKey(pem: string) {
  if (typeof pem !== 'string' || pem.length > 2000 || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error('Choose an Ed25519 public key in PEM format.');
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Receipt signatures require an Ed25519 key.');
  return key;
}
export function publicKeyFingerprint(publicKeyPem: string): string {
  return digest(publicKey(publicKeyPem).export({ type: 'spki', format: 'der' }));
}
export function generateReceiptKeyPair(): { privateKeyPem: string; publicKeyPem: string; fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicKeyPem, fingerprint: publicKeyFingerprint(publicKeyPem) };
}
export function createReceipt(payload: ReceiptPayload, privateKeyPem?: string): ExportReceipt {
  canonicalJson(payload);
  const checked = receiptPayloadSchema.parse(payload);
  const receipt: ExportReceipt = { schemaVersion: 1, payload: checked };
  if (privateKeyPem) {
    if (privateKeyPem.length > 4000) throw new Error('The signing key is invalid.');
    const key = createPrivateKey(privateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('Receipt signatures require an Ed25519 key.');
    const publicKeyPem = createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    receipt.signature = { algorithm: 'Ed25519', publicKey: publicKeyPem, value: sign(null, Buffer.from(SIGNING_DOMAIN + canonicalJson(checked)), key).toString('base64') };
  }
  return receipt;
}
export function createExportReceipt(record: SkillRecord, policy: Policy, zip: Buffer, options: { privateKeyPem?: string; includeReviewer?: boolean; target?: ExportTarget } = {}): ExportReceipt {
  const version = validateRelease(record, policy);
  if (zip.length > LIMITS.totalBytes + 2_000_000) throw new Error('The export package is too large for a receipt.');
  const packageSha256 = digest(zip);
  const targets: ExportTarget[] = options.target ? [options.target] : ['portable', 'claude', 'chatgpt', 'codex'];
  if (!targets.some(target => {
    try { return digest(exportRelease(record, policy, target)) === packageSha256; } catch { return false; }
  })) throw new Error('The receipt package does not match this approved release. Export it again.');
  return createReceipt({ schemaVersion: 1, packageSha256, contentHash: version.contentHash,
    policyHash: hashPolicy(policy), policyId: policy.id, policyVersion: policy.version,
    reviewId: record.review!.id, approvalTimestamp: record.approval!.approvedAt, permissionBasis: record.approval!.permissionBasis,
    ...(options.includeReviewer ? { reviewer: record.approval!.reviewer } : {}),
  }, options.privateKeyPem);
}
/** Cryptographic integrity is separate from independently trusted identity and from permission claims. */
export function verifyReceipt(input: unknown, zip: Buffer, trustedPublicKeyPem?: string): ReceiptVerification {
  const result: ReceiptVerification = { valid: false, packageMatches: false, signatureValid: null, signerTrusted: false, errors: [] };
  try {
    const serialized = canonicalJson(input);
    if (Buffer.byteLength(serialized) > 16000) throw new Error('The receipt is too large.');
    const receipt = exportReceiptSchema.parse(input);
    if (zip.length > LIMITS.totalBytes + 2_000_000) throw new Error('The package is too large.');
    result.packageMatches = digest(zip) === receipt.payload.packageSha256;
    if (!result.packageMatches) result.errors.push('The package bytes do not match the receipt.');
    if (receipt.signature) {
      const key = publicKey(receipt.signature.publicKey);
      result.fingerprint = publicKeyFingerprint(receipt.signature.publicKey);
      result.signatureValid = verify(null, Buffer.from(SIGNING_DOMAIN + canonicalJson(receipt.payload)), key, Buffer.from(receipt.signature.value, 'base64'));
      if (!result.signatureValid) result.errors.push('The receipt signature is invalid.');
      if (trustedPublicKeyPem) result.signerTrusted = result.signatureValid && result.fingerprint === publicKeyFingerprint(trustedPublicKeyPem);
    }
    result.valid = result.packageMatches && result.signatureValid !== false;
  } catch {
    result.errors.push('The receipt, package, or trusted key has an invalid format.');
    result.valid = false;
  }
  return result;
}
