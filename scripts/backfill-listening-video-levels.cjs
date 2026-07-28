#!/usr/bin/env node
/*
 * Re-derives listening_video.computed_levels from actual transcript vocabulary
 * (via src/lib/listeningLevelClassifier.ts) instead of trusting the scraped
 * corodomo.com "levels" tag alone. Run `npm run build` first.
 *
 * Usage:
 *   node scripts/backfill-listening-video-levels.cjs --dry-run   (report only, no writes)
 *   node scripts/backfill-listening-video-levels.cjs             (writes computed_levels)
 */

const path = require('path');

const root = path.resolve(__dirname, '..');
const { classifyListeningLevelFromTranscript } = require(path.join(root, 'dist', 'lib', 'listeningLevelClassifier.js'));
const { prisma } = require(path.join(root, 'dist', 'lib', 'prisma.js'));

const dryRun = process.argv.includes('--dry-run');

function existingLevel(row) {
  const levels = Array.isArray(row.levels) ? row.levels : [];
  const normalizedLevels = Array.isArray(row.normalized_levels) ? row.normalized_levels : [];
  return normalizedLevels.length > 0 ? normalizedLevels : levels;
}

async function main() {
  const videos = await prisma.$queryRawUnsafe(`
    SELECT video_id, title, levels, normalized_levels
    FROM listening_video
    WHERE EXISTS (SELECT 1 FROM listening_transcript_line l WHERE l.video_id = listening_video.video_id)
    ORDER BY inserted_at ASC
  `);

  console.log(`Found ${videos.length} videos with a transcript.${dryRun ? ' (dry run, no writes)' : ''}`);

  let changed = 0;
  let skippedInsufficientData = 0;
  const changes = [];

  for (const video of videos) {
    const lineRows = await prisma.$queryRawUnsafe(
      `SELECT text FROM listening_transcript_line WHERE video_id = $1 ORDER BY line_index ASC`,
      video.video_id,
    );
    const transcriptText = lineRows.map((line) => line.text).join('\n');
    const { levels, stats } = await classifyListeningLevelFromTranscript(transcriptText);

    if (stats.reason === 'insufficient-data') {
      skippedInsufficientData += 1;
      continue;
    }

    const before = existingLevel(video).map((l) => String(l).toLowerCase());
    const same = before.length === levels.length && before.every((l) => levels.includes(l));
    if (!same) {
      changed += 1;
      changes.push({
        videoId: video.video_id,
        title: video.title,
        before,
        after: levels,
        matchedTokens: stats.matchedTokens,
        countsByLevel: stats.countsByLevel,
      });
    }

    if (!dryRun) {
      await prisma.$executeRawUnsafe(
        `UPDATE listening_video SET computed_levels = $1, computed_level_stats = $2::jsonb, computed_level_at = NOW() WHERE video_id = $3`,
        levels,
        JSON.stringify(stats),
        video.video_id,
      );
    }
  }

  console.log(`\nWould reclassify: ${changed} / ${videos.length} videos (skipped ${skippedInsufficientData} with too little transcript signal)`);
  console.log('\n--- Sample of reclassified videos (up to 40) ---');
  for (const change of changes.slice(0, 40)) {
    console.log(
      `[${change.before.join(',') || '(none)'} -> ${change.after.join(',')}] (${change.matchedTokens} matched words, ${JSON.stringify(change.countsByLevel)}) ${change.videoId} ${change.title}`,
    );
  }

  const beforeDist = {};
  const afterDist = {};
  for (const video of videos) {
    for (const level of existingLevel(video).map((l) => String(l).toLowerCase())) {
      beforeDist[level] = (beforeDist[level] || 0) + 1;
    }
  }
  for (const change of changes) {
    for (const level of change.after) {
      afterDist[level] = (afterDist[level] || 0) + 1;
    }
  }
  const unchangedByLevel = {};
  for (const video of videos) {
    const isChanged = changes.some((c) => c.videoId === video.video_id);
    if (!isChanged) {
      for (const level of existingLevel(video).map((l) => String(l).toLowerCase())) {
        afterDist[level] = (afterDist[level] || 0) + 1;
        unchangedByLevel[level] = (unchangedByLevel[level] || 0) + 1;
      }
    }
  }
  console.log('\n--- Level distribution (videos can carry multiple tags) ---');
  console.log('before:', beforeDist);
  console.log('after: ', afterDist);

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
