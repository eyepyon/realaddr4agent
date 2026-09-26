import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import type { EncryptedPaymentPayload } from '@realaddr/db';

export function secretKey(value: string | undefined): Buffer {
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('invalid_world_encryption_key');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('invalid_world_encryption_key');
  return key;
}
export function seal(key: Buffer, purpose: string, resource: string, plaintext: string): EncryptedPaymentPayload {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(['realaddr', purpose, resource])));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { algorithm: 'aes-256-gcm', keyId: 'v1', iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function open(key: Buffer, purpose: string, resource: string, envelope: EncryptedPaymentPayload): string {
  if (envelope.algorithm !== 'aes-256-gcm' || envelope.keyId !== 'v1') throw new Error('invalid_envelope');
  const decode = (value: string) => { const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) throw new Error('invalid_envelope'); return bytes; };
  const iv = decode(envelope.iv), tag = decode(envelope.tag), ciphertext = decode(envelope.ciphertext);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length > 16384) throw new Error('invalid_envelope');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(JSON.stringify(['realaddr', purpose, resource])));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
export function subjectHash(key: Buffer, issuer: string, subject: string): string {
  return createHmac('sha256', key).update(JSON.stringify(['realaddr-world-subject-v1', issuer, subject])).digest('hex');
}
