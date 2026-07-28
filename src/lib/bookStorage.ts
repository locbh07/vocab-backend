import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const BUCKET = process.env.R2_BUCKET || 'books';
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;
const UPLOAD_URL_TTL_SECONDS = 15 * 60;
const COVER_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const COVER_URL_WINDOW_MS = 24 * 60 * 60 * 1000;

let cachedClient: S3Client | null = null;

function getR2Client(): S3Client {
  if (cachedClient) return cachedClient;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('Missing R2_ACCOUNT_ID, R2_ACCESS_KEY_ID or R2_SECRET_ACCESS_KEY');
  }

  cachedClient = new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  return cachedClient;
}

function sanitizeFileName(name: string): string {
  const safe = String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9_.-]/g, '_');
  return safe.slice(-150) || 'book.pdf';
}

export function buildBookStoragePath(userId: number, originalFileName: string): string {
  return `${userId}/${Date.now()}-${sanitizeFileName(originalFileName)}`;
}

export function coverStorageKeyFor(storagePath: string): string {
  return `${storagePath}.cover.jpg`;
}

export function pagesPrefixFor(storagePath: string): string {
  return `${storagePath}.pages`;
}

export function pageStorageKeyFor(storagePath: string, pageNum: number): string {
  return `${pagesPrefixFor(storagePath)}/${pageNum}.jpg`;
}

export async function createUploadSignedUrl(storagePath: string, contentType: string): Promise<string> {
  const client = getR2Client();
  return getSignedUrl(
    client,
    new PutObjectCommand({ Bucket: BUCKET, Key: storagePath, ContentType: contentType }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );
}

export async function createDownloadSignedUrl(storagePath: string): Promise<string> {
  const client = getR2Client();
  try {
    return await getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: storagePath }), {
      expiresIn: DOWNLOAD_URL_TTL_SECONDS,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error';
    const err = new Error(`Không thể tạo link xem file: ${message}`) as Error & { status?: number };
    err.status = 500;
    throw err;
  }
}

// Cover thumbnails are the same non-sensitive image for everyone, forever (a given storagePath
// is never overwritten), so they're the one asset worth making genuinely browser-cacheable.
// `createDownloadSignedUrl` re-signs with the current timestamp on every call, which produces a
// brand-new URL each time — even a `max-age` response header can't help the browser reuse its
// cache if the URL itself never repeats. Quantizing the expiry to a stable daily window keeps
// the signed URL (and therefore the cache key) identical across repeat page loads within that
// window, and `ResponseCacheControl` tells the browser to keep it for a full year once fetched.
export async function createCoverSignedUrl(storagePath: string): Promise<string> {
  const client = getR2Client();
  const now = Date.now();
  const windowEnd = Math.ceil(now / COVER_URL_WINDOW_MS) * COVER_URL_WINDOW_MS;
  const expiresIn = Math.ceil((windowEnd - now) / 1000) + 60 * 60;

  try {
    return await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: BUCKET, Key: storagePath, ResponseCacheControl: COVER_CACHE_CONTROL }),
      { expiresIn },
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'unknown error';
    const err = new Error(`Không thể tạo link ảnh bìa: ${message}`) as Error & { status?: number };
    err.status = 500;
    throw err;
  }
}

export async function headObjectSize(storagePath: string): Promise<number | null> {
  const client = getR2Client();
  try {
    const res = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: storagePath }));
    return res.ContentLength ?? null;
  } catch {
    return null;
  }
}

export async function deleteStorageObjects(storagePaths: string[]): Promise<void> {
  const client = getR2Client();
  await Promise.all(
    storagePaths.map((key) =>
      client
        .send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }))
        .catch(() => undefined),
    ),
  );
}
