import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localRoot = path.resolve(process.env.FILE_STORAGE_DIR?.trim() || path.join(SERVER_ROOT, 'data/files'));
const tempRoot = path.join(SERVER_ROOT, 'uploads');
const s3Bucket = String(process.env.S3_BUCKET || '').trim();
const s3Endpoint = String(process.env.S3_ENDPOINT || '').trim().replace(/\/$/, '');
const s3Region = String(process.env.S3_REGION || 'auto').trim();
const s3AccessKeyId = String(process.env.S3_ACCESS_KEY_ID || '').trim();
const s3SecretAccessKey = String(process.env.S3_SECRET_ACCESS_KEY || '').trim();
const useS3 = Boolean(s3Bucket && s3Endpoint && s3AccessKeyId && s3SecretAccessKey);

fs.mkdirSync(localRoot, { recursive: true });
fs.mkdirSync(tempRoot, { recursive: true });

function safeName(name: string) {
  return path.basename(name).replace(/[^a-zA-Z0-9._() -]/g, '_').slice(0, 180) || 'file';
}

function isCloudReference(value: string) {
  return value.startsWith('s3://');
}

function cloudKey(reference: string) {
  const prefix = `s3://${s3Bucket}/`;
  if (!isCloudReference(reference) || !reference.startsWith(prefix)) throw new Error('Unsupported cloud storage reference');
  return reference.slice(prefix.length);
}

function objectUrl(key: string) {
  if (!s3Endpoint || !s3Bucket) throw new Error('Cloud object storage is not configured');
  const base = new URL(s3Endpoint);
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${encodeURIComponent(s3Bucket)}/${encodedKey}`;
  return base;
}

function hmac(key: crypto.BinaryLike, value: string) {
  return crypto.createHmac('sha256', key).update(value, 'utf8').digest();
}

function signingKey(date: string) {
  const dateKey = hmac(`AWS4${s3SecretAccessKey}`, date);
  const regionKey = hmac(dateKey, s3Region);
  const serviceKey = hmac(regionKey, 's3');
  return hmac(serviceKey, 'aws4_request');
}

async function cloudRequest(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Buffer, contentType = 'application/octet-stream') {
  if (!useS3) throw new Error('Cloud object storage is not configured');
  const url = objectUrl(key);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const day = stamp.slice(0, 8);
  const payload = body || Buffer.alloc(0);
  const payloadHash = crypto.createHash('sha256').update(payload).digest('hex');
  const canonicalHeaders = `content-type:${contentType}\nhost:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${stamp}\n`;
  const signedHeaders = 'content-type;host;x-amz-content-sha256;x-amz-date';
  const scope = `${day}/${s3Region}/s3/aws4_request`;
  const canonicalRequest = [method, url.pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(day)).update(stringToSign, 'utf8').digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${s3AccessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': contentType,
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      authorization
    },
    body: method === 'GET' || method === 'DELETE' ? undefined : body as any
  });
  if (!response.ok) throw new Error(`Cloud object storage ${method} failed (${response.status})`);
  return response;
}

export async function persistUploadedFile(input: { sourcePath: string; userId: number; documentId: number; name: string; type: string }) {
  const filename = safeName(input.name);
  if (useS3) {
    const key = `users/${input.userId}/documents/${input.documentId}/${crypto.randomUUID()}-${filename}`;
    const data = await fsp.readFile(input.sourcePath);
    await cloudRequest('PUT', key, data, input.type || 'application/octet-stream');
    await fsp.unlink(input.sourcePath).catch(() => {});
    return `s3://${s3Bucket}/${key}`;
  }
  const directory = path.join(localRoot, String(input.userId), String(input.documentId));
  const destination = path.join(directory, filename);
  await fsp.mkdir(directory, { recursive: true });
  await fsp.copyFile(input.sourcePath, destination);
  await fsp.unlink(input.sourcePath).catch(() => {});
  return destination;
}

export async function materializeStoredFile(reference: string, name = 'document') {
  if (!isCloudReference(reference)) {
    if (!fs.existsSync(reference)) throw new Error('Stored file not found');
    return { path: reference, cleanup: async () => {} };
  }
  const response = await cloudRequest('GET', cloudKey(reference));
  const destination = path.join(tempRoot, `download-${crypto.randomUUID()}-${safeName(name)}`);
  await fsp.writeFile(destination, Buffer.from(await response.arrayBuffer()));
  return { path: destination, cleanup: async () => { await fsp.unlink(destination).catch(() => {}); } };
}

export async function sendStoredFile(res: any, reference: string, name: string, type: string, download = false) {
  if (!isCloudReference(reference)) {
    if (!fs.existsSync(reference)) throw new Error('Stored file not found');
    return download ? res.download(path.resolve(reference), name) : res.type(type || 'application/octet-stream').sendFile(path.resolve(reference));
  }
  const response = await cloudRequest('GET', cloudKey(reference));
  const content = Buffer.from(await response.arrayBuffer());
  res.type(type || 'application/octet-stream');
  if (download) res.attachment(name);
  return res.send(content);
}

export async function deleteStoredFile(reference?: string | null) {
  if (!reference) return;
  if (!isCloudReference(reference)) {
    await fsp.unlink(reference).catch(() => {});
    return;
  }
  await cloudRequest('DELETE', cloudKey(reference)).catch(() => {});
}

export const storageStatus = {
  mode: useS3 ? 's3' : 'persistent-volume',
  cloudConfigured: useS3
};
