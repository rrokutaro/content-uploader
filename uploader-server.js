#!/usr/bin/env node
/**
 * uploader-server.js
 *
 * Fetches generated videos from Google Drive, scrapes channels to detect
 * already-uploaded videos, and uploads new videos to YouTube in a fair,
 * round-robin fashion across server configs and channels.
 *
 * Zip filename format (produced by upload_to_gdrive on the generator side):
 *   <score>_<config_id>_UNIV-<univ>.zip
 *   e.g.  87.50_sU8kTYfixdGil2l6_UNIV-d3af9b21c0.zip
 *
 * UNIV in YouTube description:
 *   Appended as  \n\nUNIV::<univ>  at the very end of every description.
 *
 * Zip contents:
 *   <video>.(mp4|mov|mkv|webm)
 *   <thumbnail>.(jpg|jpeg|png|webp)   (optional)
 *   metadata.json
 *
 * Usage:
 *   node uploader-server.js [options]
 *
 * Options:
 *   --configs           <a.json,b.json>   Config filenames under assets/server-configs/. REQUIRED.
 *   --min-gap           <ms>              Min ms between uploads from this IP.
 *                                         Default: config.scheduled_upload_delay or 1 800 000.
 *   --window            <HH:MM-HH:MM>     UTC upload window only. e.g. "13:00-23:00".
 *   --log-file          <path>            Append-only log. Default: ./uploader-server.log
 *   --dry-run                             Parse/score/scrape but do NOT upload or delete.
 *   --refetch-interval  <seconds>         Re-fetch configs/secrets/tokens from GDrive.
 *                                         Default: 600 (10 min).
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { google }    = require('googleapis');

// ─────────────────────────────────────────────────────────────────────────────
// CLI ARGUMENT PARSING
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        configs:         null,
        minGap:          null,    // ms override; null → use config value
        window:          null,    // "HH:MM-HH:MM" UTC
        logFile:         path.join(__dirname, 'uploader-server.log'),
        dryRun:          false,
        refetchInterval: 600,     // seconds
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--configs':           opts.configs         = args[++i]; break;
            case '--min-gap':           opts.minGap          = parseInt(args[++i], 10); break;
            case '--window':            opts.window          = args[++i]; break;
            case '--log-file':          opts.logFile         = args[++i]; break;
            case '--dry-run':           opts.dryRun          = true;      break;
            case '--refetch-interval':  opts.refetchInterval = parseInt(args[++i], 10); break;
        }
    }

    if (!opts.configs) {
        console.error('❌  --configs is required.  e.g. --configs config1.json,config2.json');
        process.exit(1);
    }

    opts.configList = opts.configs.split(',').map(s => s.trim()).filter(Boolean);
    return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER  (stdout + append-only .log file)
// ─────────────────────────────────────────────────────────────────────────────
function makeLogger(logFilePath) {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    const stream = fs.createWriteStream(logFilePath, { flags: 'a' });

    function write(level, ...parts) {
        const ts  = new Date().toISOString();
        const msg = parts
            .map(p => (p && typeof p === 'object' ? JSON.stringify(p) : String(p)))
            .join(' ');
        const line = `[${ts}] [${level}] ${msg}`;
        console.log(line);
        stream.write(line + '\n');
    }

    return {
        info:    (...a) => write('INFO   ', ...a),
        success: (...a) => write('SUCCESS', ...a),
        warn:    (...a) => write('WARN   ', ...a),
        error:   (...a) => write('ERROR  ', ...a),
        debug:   (...a) => write('DEBUG  ', ...a),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** True when the current UTC time falls inside a "HH:MM-HH:MM" window. */
function inUploadWindow(windowStr) {
    if (!windowStr) return true;
    const now    = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [s, e] = windowStr.split('-').map(tok => {
        const [h, m] = tok.split(':').map(Number);
        return h * 60 + m;
    });
    // Handles windows that span midnight (e.g. "22:00-06:00")
    return s <= e
        ? (nowMin >= s && nowMin < e)
        : (nowMin >= s || nowMin < e);
}

function readJSON(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return null; }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// FILENAME PARSER
//
// Exact format from upload_to_gdrive():
//   `${score.toFixed(2)}_${config_id}_UNIV-${univ}.zip`
// e.g.
//   87.50_sU8kTYfixdGil2l6_UNIV-d3af9b21c0.zip
//
// Returns { score, configId, univ, filename, base } or null on mismatch.
// ─────────────────────────────────────────────────────────────────────────────
function parseVideoFilename(filename) {
    const base  = path.basename(filename, '.zip');
    //                   score          config_id      univ
    const match = base.match(/^([\d.]+)_([^_]+)_UNIV-(.+)$/);
    if (!match) return null;
    return {
        score:    parseFloat(match[1]),
        configId: match[2],
        univ:     match[3],
        filename,
        base,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE  (.uploader-state.json)
// ─────────────────────────────────────────────────────────────────────────────
const STATE_FILE = path.join(__dirname, '.uploader-state.json');

function loadState() {
    return readJSON(STATE_FILE) || {
        lastUploadTime: 0,    // epoch ms — last physical upload on this server
        configCursor:   0,    // which config index to resume from
        channelCursors: {},   // { configId: nextChannelIndex }
        seenUnivs:      {},   // { univ: true } — persisted dedup cache
    };
}

function saveState(state) {
    writeJSON(STATE_FILE, state);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH2 CLIENT  (shared by Drive and YouTube helpers)
//
// Token storage format (from upload_to_gdrive):
//   { tokens: { access_token, refresh_token, … } }
// — but also handles bare  { access_token, refresh_token, … }
//
// On token refresh we merge rather than overwrite, so refresh_token is
// never accidentally lost (mirrors the [Fix 1 & 5] in upload_to_gdrive).
// ─────────────────────────────────────────────────────────────────────────────
function buildOAuthClient(clientFile, tokenFile, log, label) {
    const clientPath = path.join(__dirname, 'assets/client-secrets', clientFile);
    const tokenPath  = path.join(__dirname, 'assets/client-tokens',  tokenFile);

    const creds = JSON.parse(fs.readFileSync(clientPath, 'utf8'));
    const keys  = creds.installed || creds.web;
    if (!keys) throw new Error(`Invalid client secret structure in ${clientFile}`);

    const { client_id, client_secret, redirect_uris } = keys;
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const stored = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oAuth2.setCredentials(stored.tokens ?? stored);

    oAuth2.on('tokens', newToken => {
        try {
            const current = readJSON(tokenPath) || {};
            // Merge: keep any key that the new event omits (especially refresh_token)
            const merged  = { ...current, ...newToken };
            if (!newToken.refresh_token) {
                const existing = current.refresh_token || current.tokens?.refresh_token;
                if (existing) merged.refresh_token = existing;
            }
            fs.writeFileSync(tokenPath, JSON.stringify(merged));
            log.info(`OAuth token refreshed and saved for ${label}`);
        } catch (e) {
            log.error(`Failed to persist refreshed token for ${label}: ${e.message}`);
        }
    });

    return oAuth2;
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE DRIVE  — list / download / delete
// ─────────────────────────────────────────────────────────────────────────────

/** Returns [{ id, name }] for all .zip files in folderId, all pages. */
async function listDriveZips(auth, folderId, log) {
    const drive = google.drive({ version: 'v3', auth });
    let files   = [];
    let pageToken;

    do {
        const res = await drive.files.list({
            q:         `'${folderId}' in parents and name contains '.zip' and trashed = false`,
            fields:    'nextPageToken, files(id, name)',
            pageSize:  1000,
            pageToken,
        });
        files     = files.concat(res.data.files || []);
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    log.info(`Drive folder ${folderId}: ${files.length} zip(s)`);
    return files;
}

/** Stream-download a Drive file to destPath. */
async function downloadDriveFile(auth, fileId, destPath, log) {
    const drive = google.drive({ version: 'v3', auth });
    const dest  = fs.createWriteStream(destPath);

    const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
        res.data.on('end',   resolve);
        res.data.on('error', reject);
        res.data.pipe(dest);
    });

    log.info(`Downloaded ${fileId} → ${destPath}`);
}

/** Permanently delete a Drive file (bypasses trash). */
async function deleteDriveFile(auth, fileId, log) {
    const drive = google.drive({ version: 'v3', auth });
    await drive.files.delete({ fileId });
    log.info(`Deleted Drive file ${fileId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL SCRAPER  (yt-dlp)
//
// The generator appends  \n\nUNIV::<univ>  to every uploaded video's
// description, so we scan recent descriptions for that exact tag.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true if  UNIV::<univ>  appears in any of the channel's most recent
 * `limit` video descriptions.
 * Fails open (returns false) so a scrape error never silently blocks an upload.
 */
function channelAlreadyHasUniv(channelId, univ, limit, log) {
    log.info(`Scraping channel ${channelId} for UNIV::${univ} (last ${limit} videos)...`);

    const result = spawnSync('yt-dlp', [
        `https://www.youtube.com/channel/${channelId}/videos`,
        '--flat-playlist',
        '--playlist-end', String(limit),
        '--print', '%(description)s',
        '--no-warnings',
        '--quiet',
    ], { encoding: 'utf8', timeout: 90_000 });

    if (result.error) {
        log.warn(`yt-dlp spawn error for channel ${channelId}: ${result.error.message}`);
        return false;
    }

    const needle = `UNIV::${univ}`;
    const found  = (result.stdout || '').includes(needle);
    if (found) log.info(`UNIV::${univ} already present in channel ${channelId}`);
    return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unzip zipPath into destDir.
 * Returns { videoPath, thumbnailPath (or null), metadata (object) }.
 */
function extractZip(zipPath, destDir, log) {
    fs.mkdirSync(destDir, { recursive: true });

    const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`unzip failed: ${res.stderr}`);

    const files         = fs.readdirSync(destDir);
    const videoFile     = files.find(f => /\.(mp4|mov|mkv|webm)$/i.test(f));
    const thumbFile     = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    const metaFile      = files.find(f => f === 'metadata.json');

    if (!videoFile) throw new Error(`No video file found inside ${zipPath}`);

    const videoPath     = path.join(destDir, videoFile);
    const thumbnailPath = thumbFile ? path.join(destDir, thumbFile) : null;
    const metadata      = metaFile  ? (readJSON(path.join(destDir, metaFile)) || {}) : {};

    log.info(`Extracted: video=${videoFile}  thumb=${thumbFile || 'none'}  meta=${metaFile || 'none'}`);
    return { videoPath, thumbnailPath, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

async function uploadToYouTube(auth, videoPath, thumbnailPath, metadata, cfg, log) {
    const youtube       = google.youtube({ version: 'v3', auth });
    const isScheduled   = cfg.scheduled_uploads === true;
    const privacyStatus = isScheduled ? 'private' : 'public';

    const publishAt = isScheduled
        ? new Date(Date.now() + (cfg.scheduled_content_buffer || 43_200_000)).toISOString()
        : undefined;

    const videoSize = fs.statSync(videoPath).size;
    let   lastLog   = 0;

    const requestParams = {
        part: 'snippet,status',
        requestBody: {
            snippet: {
                title:                metadata.title        || 'Untitled',
                description:          metadata.description  || '',
                tags:                 metadata.tags         || [],
                categoryId:           String(metadata.categoryId || 22),
                defaultLanguage:      'en',
                defaultAudioLanguage: 'en',
            },
            status: {
                privacyStatus,
                selfDeclaredMadeForKids: false,
                embeddable:              true,
                publicStatsViewable:     true,
                ...(publishAt ? { publishAt } : {}),
            },
        },
        media: { body: fs.createReadStream(videoPath) },
    };

    log.info(`Uploading "${metadata.title || path.basename(videoPath)}" (${(videoSize / 1e6).toFixed(1)} MB) → ${privacyStatus}${publishAt ? ' @ ' + publishAt : ''}...`);
    const t0 = Date.now();

    const response = await youtube.videos.insert(requestParams, {
        onUploadProgress: evt => {
            const now = Date.now();
            if (now - lastLog > 15_000) {
                const pct = videoSize ? ((evt.bytesRead / videoSize) * 100).toFixed(0) : '?';
                log.info(`Upload progress: ${pct}%`);
                lastLog = now;
            }
        },
    });

    const videoId = response.data.id;
    log.success(`Upload done in ${((Date.now() - t0) / 1000).toFixed(1)}s — video ID: ${videoId}`);

    // Set thumbnail (only works if channel is YT-verified; non-fatal if it fails)
    if (thumbnailPath && videoId) {
        try {
            await youtube.thumbnails.set({
                videoId,
                media: {
                    mimeType: /\.png$/i.test(thumbnailPath) ? 'image/png' : 'image/jpeg',
                    body:     fs.createReadStream(thumbnailPath),
                },
            });
            log.success(`Thumbnail set for ${videoId}`);
        } catch (e) {
            log.warn(`Thumbnail upload skipped (channel may not be verified): ${e.message}`);
        }
    }

    return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSET RE-FETCH  (mirrors gdown logic from on-start-script.sh)
// Runs at startup and every `refetchInterval` seconds thereafter.
// ─────────────────────────────────────────────────────────────────────────────
function refetchAssets(log) {
    const tasks = [
        { envId: 'GDRIVE_SERVER_CONFIGS_ID', dest: 'assets/server-configs', skipEnv: 'DISABLE_SERVER_CONFIGS_FETCH' },
        { envId: 'GDRIVE_CLIENT_SECRETS_ID', dest: 'assets/client-secrets', skipEnv: 'DISABLE_CLIENT_SECRETS_FETCH' },
        { envId: 'GDRIVE_CLIENT_TOKENS_ID',  dest: 'assets/client-tokens',  skipEnv: 'DISABLE_CLIENT_TOKENS_FETCH'  },
    ];

    for (const t of tasks) {
        if (process.env[t.skipEnv] === 'true') {
            log.info(`Skipping re-fetch of ${t.dest} (${t.skipEnv}=true)`);
            continue;
        }
        const fileId = process.env[t.envId];
        if (!fileId) {
            log.warn(`${t.envId} not set — skipping re-fetch of ${t.dest}`);
            continue;
        }

        const tmpZip = `/tmp/refetch_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`;
        try {
            log.info(`Re-fetching ${t.dest} (GDrive ${fileId})...`);
            const dl = spawnSync('gdown', [
                `https://drive.google.com/uc?id=${fileId}`,
                '-O', tmpZip,
                '--quiet',
            ], { encoding: 'utf8', timeout: 120_000 });

            if (dl.status !== 0 || !fs.existsSync(tmpZip)) {
                log.warn(`gdown failed for ${t.dest}: ${(dl.stderr || '').trim()}`);
                continue;
            }

            fs.rmSync(t.dest, { recursive: true, force: true });
            fs.mkdirSync(t.dest, { recursive: true });
            spawnSync('unzip', ['-q', '-o', tmpZip, '-d', t.dest], { encoding: 'utf8' });
            fs.rmSync(tmpZip, { force: true });
            log.success(`Re-fetched ${t.dest}`);
        } catch (e) {
            log.error(`Re-fetch error for ${t.dest}: ${e.message}`);
            try { fs.rmSync(tmpZip, { force: true }); } catch (_) {}
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
async function run(opts, log) {
    const SCRAPE_LIMIT = 20;

    let state       = loadState();
    let lastRefetch = 0;

    async function maybeRefetch() {
        if (Date.now() - lastRefetch >= opts.refetchInterval * 1000) {
            refetchAssets(log);
            lastRefetch = Date.now();
        }
    }

    function loadConfigs() {
        return opts.configList
            .map(filename => {
                const p   = path.join(__dirname, 'assets/server-configs', filename);
                const cfg = readJSON(p);
                if (!cfg) log.error(`Cannot read config: ${p}`);
                return cfg;
            })
            .filter(Boolean);
    }

    // ── startup log ───────────────────────────────────────────────────────────
    log.info('══════════════════════════════════════════');
    log.info('uploader-server starting');
    log.info(`Configs:          ${opts.configList.join(', ')}`);
    log.info(`Dry run:          ${opts.dryRun}`);
    log.info(`Upload window:    ${opts.window || 'unrestricted (UTC)'}`);
    log.info(`Min gap override: ${opts.minGap != null ? opts.minGap + 'ms' : 'use config value'}`);
    log.info(`Refetch interval: ${opts.refetchInterval}s`);
    log.info('══════════════════════════════════════════');

    await maybeRefetch();
    const configs     = loadConfigs();
    const configCount = configs.length;

    if (!configCount) {
        log.error('No valid configs loaded — exiting.');
        process.exit(1);
    }

    let configIdx = state.configCursor % configCount;

    // ── config round-robin ────────────────────────────────────────────────────
    for (let ci = 0; ci < configCount; ci++) {
        await maybeRefetch();

        const cfg      = configs[configIdx];
        const configId = cfg.config_id;

        log.info(`\n── Config ${configIdx + 1}/${configCount}: ${configId} ──`);

        // ── upload window check ───────────────────────────────────────────────
        if (!inUploadWindow(opts.window)) {
            log.info(`Outside upload window (${opts.window}) — skipping ${configId}`);
            configIdx = (configIdx + 1) % configCount;
            continue;
        }

        // ── build candidates list from all drives in this config ──────────────
        const candidates = [];

        for (const driveEntry of (cfg.google_drives || [])) {
            let driveAuth;
            try {
                driveAuth = buildOAuthClient(
                    driveEntry.client, driveEntry.token, log,
                    driveEntry.alias || driveEntry.name
                );
            } catch (e) {
                log.error(`Drive auth failed for "${driveEntry.alias}": ${e.message}`);
                continue;
            }

            let files;
            try {
                files = await listDriveZips(driveAuth, driveEntry.folder_id, log);
            } catch (e) {
                log.error(`Failed to list drive "${driveEntry.alias}": ${e.message}`);
                continue;
            }

            for (const f of files) {
                const parsed = parseVideoFilename(f.name);
                if (!parsed) {
                    log.debug(`Unrecognised filename (skipped): ${f.name}`);
                    continue;
                }
                if (parsed.configId !== configId) continue;
                candidates.push({ driveEntry, driveAuth, fileObj: f, parsed });
            }
        }

        // Sort highest score first
        candidates.sort((a, b) => b.parsed.score - a.parsed.score);
        log.info(`${candidates.length} candidate zip(s) for config ${configId}`);

        if (!candidates.length) {
            log.info(`Nothing to upload for ${configId} — moving on`);
            configIdx = (configIdx + 1) % configCount;
            state.configCursor = configIdx;
            saveState(state);
            continue;
        }

        // ── channels ──────────────────────────────────────────────────────────
        const channels     = cfg.channels || [];
        const channelCount = channels.length;
        if (!channelCount) {
            log.warn(`Config ${configId} has no channels`);
            configIdx = (configIdx + 1) % configCount;
            continue;
        }

        let channelIdx = (state.channelCursors[configId] || 0) % channelCount;

        // ── min-gap enforcement ───────────────────────────────────────────────
        const minGap  = opts.minGap ?? cfg.scheduled_upload_delay ?? 1_800_000;
        const elapsed = Date.now() - state.lastUploadTime;

        if (state.lastUploadTime > 0 && elapsed < minGap) {
            const waitMs = minGap - elapsed;
            log.info(`Last upload ${Math.floor(elapsed / 60000)}min ago; need ${Math.ceil(minGap / 60000)}min gap. Sleeping ${Math.ceil(waitMs / 1000)}s...`);
            await sleep(waitMs);
        }

        // ── video loop ────────────────────────────────────────────────────────
        let uploadedThisCycle = false;

        for (const { driveEntry, driveAuth, fileObj, parsed } of candidates) {
            const { univ, score, filename } = parsed;

            // ── local UNIV dedup cache ────────────────────────────────────────
            if (state.seenUnivs[univ]) {
                log.info(`UNIV ${univ} already in local cache — skipping`);
                continue;
            }

            // ── scrape every channel in this config for the UNIV tag ──────────
            // (Any channel might have received it from a previous run or server.)
            let alreadyLive = false;
            for (const ch of channels) {
                if (channelAlreadyHasUniv(ch.id, univ, SCRAPE_LIMIT, log)) {
                    alreadyLive = true;
                    break;
                }
            }

            if (alreadyLive) {
                log.info(`UNIV ${univ} already live — caching locally + removing from Drive`);
                state.seenUnivs[univ] = true;
                saveState(state);
                if (!opts.dryRun) {
                    try { await deleteDriveFile(driveAuth, fileObj.id, log); }
                    catch (e) { log.error(`Drive delete failed: ${e.message}`); }
                } else {
                    log.info(`[DRY RUN] Would delete Drive file ${fileObj.id}`);
                }
                continue;
            }

            // ── pick next eligible channel (respects daily quota) ─────────────
            const dailyLimit = cfg.max_daily_yt_upload_per_channel || 6;
            const todayKey   = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
            let   target     = null;

            for (let t = 0; t < channelCount; t++) {
                const ch       = channels[(channelIdx + t) % channelCount];
                const countKey = `__daily__${ch.name}__${todayKey}`;
                const count    = state.seenUnivs[countKey] || 0;
                if (count < dailyLimit) {
                    target     = ch;
                    channelIdx = (channelIdx + t) % channelCount;
                    break;
                }
                log.warn(`Channel "${ch.name}" at daily quota (${count}/${dailyLimit})`);
            }

            if (!target) {
                log.warn(`All channels at daily quota for config ${configId} — stopping this cycle`);
                break;
            }

            // Re-check window (in case we were sleeping for min-gap)
            if (!inUploadWindow(opts.window)) {
                log.info('Left upload window mid-loop — stopping');
                break;
            }

            // ── download zip ──────────────────────────────────────────────────
            const uid    = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const tmpZip = `/tmp/up_${uid}.zip`;
            const tmpDir = `/tmp/up_${uid}`;

            try {
                log.info(`Downloading "${filename}" (score ${score.toFixed(2)})...`);

                if (!opts.dryRun) {
                    await downloadDriveFile(driveAuth, fileObj.id, tmpZip, log);
                } else {
                    log.info(`[DRY RUN] Would download Drive file ${fileObj.id}`);
                }

                // ── extract ───────────────────────────────────────────────────
                let videoPath, thumbnailPath, metadata;
                if (!opts.dryRun) {
                    ({ videoPath, thumbnailPath, metadata } = extractZip(tmpZip, tmpDir, log));
                } else {
                    videoPath = thumbnailPath = null;
                    metadata  = {};
                    log.info(`[DRY RUN] Would extract ${filename}`);
                }

                // ── YT auth ───────────────────────────────────────────────────
                let ytAuth;
                try {
                    ytAuth = buildOAuthClient(target.client, target.token, log, target.name);
                } catch (e) {
                    log.error(`YT auth failed for "${target.name}": ${e.message} — skipping channel`);
                    channelIdx = (channelIdx + 1) % channelCount;
                    continue;
                }

                // ── upload ────────────────────────────────────────────────────
                if (!opts.dryRun) {
                    await uploadToYouTube(ytAuth, videoPath, thumbnailPath, metadata, cfg, log);
                } else {
                    log.info(`[DRY RUN] Would upload "${filename}" → channel "${target.name}"`);
                }

                // ── bookkeeping ───────────────────────────────────────────────
                state.lastUploadTime = Date.now();
                state.seenUnivs[univ] = true;

                const countKey = `__daily__${target.name}__${todayKey}`;
                state.seenUnivs[countKey] = (state.seenUnivs[countKey] || 0) + 1;

                // Advance channel cursor → next upload goes to the next channel
                channelIdx = (channelIdx + 1) % channelCount;
                state.channelCursors[configId] = channelIdx;
                saveState(state);

                // ── delete from Drive ─────────────────────────────────────────
                if (cfg.delete_videos_after_uploads !== false) {
                    if (!opts.dryRun) {
                        try { await deleteDriveFile(driveAuth, fileObj.id, log); }
                        catch (e) { log.error(`Drive delete failed (non-fatal): ${e.message}`); }
                    } else {
                        log.info(`[DRY RUN] Would delete Drive file ${fileObj.id}`);
                    }
                }

                uploadedThisCycle = true;
                log.success(`✅  Done — config: ${configId}  channel: ${target.name}  UNIV: ${univ}  score: ${score.toFixed(2)}`);
                break; // one upload per config per outer-loop turn

            } catch (e) {
                log.error(`Pipeline failed for "${filename}": ${e.message}`);
                if (e.stack) log.debug(e.stack);
            } finally {
                try { fs.rmSync(tmpZip, { force: true }); }                    catch (_) {}
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); }  catch (_) {}
            }
        } // end video loop

        if (!uploadedThisCycle) {
            log.info(`No upload this cycle for config ${configId}`);
        }

        // Advance config cursor for next run
        configIdx = (configIdx + 1) % configCount;
        state.configCursor = configIdx;
        saveState(state);

    } // end config loop

    log.info('All configs processed for this run.');
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    const opts = parseArgs();
    const log  = makeLogger(opts.logFile);
    try {
        await run(opts, log);
    } catch (e) {
        log.error(`Fatal: ${e.message}`);
        if (e.stack) log.error(e.stack);
        process.exit(1);
    }
})();
