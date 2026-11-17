#!/usr/bin/env node
/**
 * Post-build validation.
 *
 * Verifies that every file the manifest advertises actually exists, that the
 * documents parse, and that a few invariants hold. Exits non-zero on failure so
 * CI never publishes a broken API.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const apiDir = path.join(publicDir, 'api', 'v1');

const failures = [];
const warnings = [];

function fail(message) {
  failures.push(message);
}

function warn(message) {
  warnings.push(message);
}

async function readJson(relative) {
  const file = path.join(publicDir, relative);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    fail(`${relative}: ${error.message}`);
    return null;
  }
}

async function assertExists(relative) {
  try {
    const stats = await fs.stat(path.join(publicDir, relative));
    if (stats.size === 0) fail(`${relative} is empty`);
    return true;
  } catch {
    fail(`${relative} is missing`);
    return false;
  }
}

// --- required files ---------------------------------------------------------

const REQUIRED = [
  'api/v1/index.json',
  'api/v1/channels.json',
  'api/v1/streams.json',
  'api/v1/countries.json',
  'api/v1/categories.json',
  'api/v1/languages.json',
  'api/v1/health.json',
  'api/v1/search.json',
  'api/v1/openapi.json',
  'playlists/index.m3u',
  'playlists/best.m3u',
  'index.html',
];

for (const relative of REQUIRED) await assertExists(relative);

// --- manifest ---------------------------------------------------------------

const manifest = await readJson('api/v1/index.json');
if (manifest) {
  if (!manifest.generated_at || Number.isNaN(Date.parse(manifest.generated_at))) {
    fail('manifest.generated_at is not a valid timestamp');
  }
  if (!manifest.counts || manifest.counts.channels <= 0) {
    fail('manifest reports zero channels');
  }
  if (manifest.counts?.streams <= 0) fail('manifest reports zero streams');
}

// --- channels ---------------------------------------------------------------

const channels = await readJson('api/v1/channels.json');
if (Array.isArray(channels)) {
  if (channels.length === 0) fail('channels.json is empty');

  const ids = new Set();
  let withStreams = 0;
  let malformed = 0;

  for (const channel of channels) {
    if (!channel.id || !channel.name) {
      malformed++;
      continue;
    }
    if (ids.has(channel.id)) fail(`duplicate channel id: ${channel.id}`);
    ids.add(channel.id);
    if (!Array.isArray(channel.streams)) malformed++;
    else if (channel.streams.length > 0) withStreams++;

    if (typeof channel.score !== 'number' || channel.score < 0 || channel.score > 100) {
      malformed++;
    }
  }

  if (malformed > 0) fail(`${malformed} malformed channel record(s)`);
  if (withStreams === 0) fail('no channel has any stream');
  if (manifest && channels.length !== manifest.counts.channels) {
    fail(`manifest says ${manifest.counts.channels} channels, file has ${channels.length}`);
  }

  console.log(`channels: ${channels.length} (${withStreams} playable)`);

  // Spot-check detail documents for channels that should definitely have one.
  // `channel_details: playable` only emits documents for channels with streams,
  // so sample from those rather than from the head of the full list.
  const sample = channels.filter((channel) => channel.streams?.length > 0).slice(0, 5);
  for (const channel of sample) {
    const relative = `api/v1/channels/${encodeURIComponent(channel.id)}.json`;
    try {
      await fs.access(path.join(publicDir, relative));
    } catch {
      warn(`detail document missing for ${channel.id} (channel_details may be disabled)`);
      break;
    }
  }
}

// --- streams ----------------------------------------------------------------

const streams = await readJson('api/v1/streams.json');
if (Array.isArray(streams)) {
  let badUrls = 0;
  let unsafeUrls = 0;
  for (const stream of streams) {
    if (typeof stream.url !== 'string' || !/^(https?|rtmps?|rtsp):\/\//i.test(stream.url)) {
      badUrls++;
    } else if (/[\r\n\t]/.test(stream.url)) {
      // A newline inside a URL silently corrupts every generated playlist.
      unsafeUrls++;
    }
  }
  if (badUrls > 0) fail(`${badUrls} stream(s) have an unsupported protocol`);
  if (unsafeUrls > 0) fail(`${unsafeUrls} stream URL(s) contain control characters`);
  console.log(`streams: ${streams.length}`);
}

// --- search index -----------------------------------------------------------

const search = await readJson('api/v1/search.json');
if (search) {
  if (!Array.isArray(search.channels)) fail('search.json has no channels array');
  else {
    const expected = search.fields?.length ?? 0;
    const bad = search.channels.filter((row) => !Array.isArray(row) || row.length !== expected);
    if (bad.length > 0) fail(`${bad.length} search row(s) have the wrong arity`);
    if (channels && search.channels.length !== channels.length) {
      fail(`search index has ${search.channels.length} rows for ${channels.length} channels`);
    }
  }
}

// --- playlists --------------------------------------------------------------

for (const relative of ['playlists/index.m3u', 'playlists/best.m3u']) {
  try {
    const content = await fs.readFile(path.join(publicDir, relative), 'utf8');
    if (!content.startsWith('#EXTM3U')) fail(`${relative} does not start with #EXTM3U`);
    const extinf = (content.match(/^#EXTINF/gm) ?? []).length;
    // Any scheme counts — rtmp/rtsp entries are legitimate playlist lines.
    const urls = content
      .split('\n')
      .filter((line) => /^[a-z][a-z0-9+.-]*:\/\//i.test(line.trim())).length;
    if (extinf !== urls) fail(`${relative}: ${extinf} #EXTINF lines but ${urls} URLs`);
    if (extinf === 0) fail(`${relative} contains no entries`);
    console.log(`${relative}: ${extinf} entries`);
  } catch (error) {
    fail(`${relative}: ${error.message}`);
  }
}

// --- EPG ----------------------------------------------------------------------
//
// Issue #14: the guide was generated and then deleted by a later `--clean`, so
// the manifest advertised programmes, every playlist's x-tvg-url pointed at the
// guide, and the guide itself 404'd. All three must agree.

{
  const guideGz = path.join(publicDir, 'epg', 'guide.xml.gz');
  const guidePlain = path.join(publicDir, 'epg', 'guide.xml');
  const guideExists = await fs
    .stat(guideGz)
    .then((stats) => stats.size > 0)
    .catch(() => false);
  const advertised = manifest?.counts?.epg_programmes ?? 0;

  if (advertised > 0 && !guideExists) {
    fail(`manifest advertises ${advertised} EPG programmes but epg/guide.xml.gz is missing`);
  }

  if (guideExists) {
    try {
      const { gunzipSync } = await import('node:zlib');
      const xml = gunzipSync(await fs.readFile(guideGz)).toString('utf8');
      const programmes = (xml.match(/<programme /g) ?? []).length;
      if (!xml.includes('<tv')) fail('epg/guide.xml.gz is not an XMLTV document');
      if (programmes === 0) fail('epg/guide.xml.gz contains no programmes');
      console.log(`epg/guide.xml.gz: ${programmes} programmes`);
    } catch (error) {
      fail(`epg/guide.xml.gz could not be read: ${error.message}`);
    }
  } else {
    await fs.access(guidePlain).catch(() => warn('no EPG guide published'));
  }

  // A playlist must never point players at a guide that is not there.
  try {
    const head = (await fs.readFile(path.join(publicDir, 'playlists', 'best.m3u'), 'utf8')).split('\n', 1)[0];
    if (/x-tvg-url=/.test(head) && !guideExists) {
      fail('playlists/best.m3u sets x-tvg-url but no guide is published');
    }
  } catch {
    /* playlist absence is reported above */
  }
}

// --- gzip siblings ----------------------------------------------------------

try {
  const entries = await fs.readdir(apiDir);
  const jsonFiles = entries.filter((name) => name.endsWith('.json'));
  const missingGz = jsonFiles.filter((name) => !entries.includes(`${name}.gz`));
  if (missingGz.length > 0 && missingGz.length === jsonFiles.length) {
    warn('no .gz siblings found (api.gzip may be disabled)');
  }
} catch {
  /* directory already reported missing */
}

// --- report -----------------------------------------------------------------

for (const message of warnings) console.warn(`WARN  ${message}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} validation failure(s):`);
  for (const message of failures) console.error(`  ✗ ${message}`);
  process.exit(1);
}

console.log('\n✓ API output looks valid');
