import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getR2Client } from './bookStorage';

const BUCKET = process.env.R2_BUCKET || 'books';
const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;

export function speakingAudioKeyFor(messageId: number | bigint): string {
  return `speaking-audio/${messageId}.mp3`;
}

export async function putSpeakingAudio(key: string, audio: Buffer, contentType: string): Promise<void> {
  const client = getR2Client();
  await client.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: audio, ContentType: contentType }),
  );
}

export async function createSpeakingAudioSignedUrl(key: string): Promise<string> {
  const client = getR2Client();
  return getSignedUrl(client, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: DOWNLOAD_URL_TTL_SECONDS,
  });
}
