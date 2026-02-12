// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.1 – FIXED TV MERGE (case-insensitive tvg-id, single channel + multi-quality)

require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

/* ===========================
   REDIS (OPTIONAL)
   =========================== */
let redisClient = null;
if (process.env.REDIS_URL) {
    try {
        const { Redis } = require('ioredis');
        redisClient = new Redis(process.env.REDIS_URL, {
            lazyConnect: true,
            maxRetriesPerRequest: 2
        });
        redisClient.on('error', e => console.error('[REDIS] Error:', e.message));
        redisClient.connect().catch(err => console.error('[REDIS] Connect failed:', err.message));
        console.log('[REDIS] Enabled');
    } catch {
        console.warn('[REDIS] Disabled (fallback to memory)');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

/* ===========================
   LOGGING
   =========================== */
const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => enabled && console.log('[DEBUG]', ...a),
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

/* ===========================
   CACHE
   =========================== */
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = 6 * 3600 * 1000;
const dataCache = new LRUCache({ max: 300, ttl: CACHE_TTL_MS });

/* ===========================
   ADDON CLASS
   =========================== */
class M3UEPGAddon {
    constructor(config, manifestRef) {
        this.config = config;
        this.manifestRef = manifestRef;
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.epgData = {};
        this.log = makeLogger(config.debug);
    }

    /* ===========================
       M3U PARSER (FIXED)
       =========================== */
    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        const channelGroups = new Map();
        let currentItem = null;

        const normalize = v => typeof v === 'string' ? v.trim().toLowerCase() : '';

        for (const raw of lines) {
            const line = raw.trim();

            if (line.startsWith('#EXTINF:')) {
                const m = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
                if (m) {
                    currentItem = {
                        duration: parseInt(m[1], 10),
                        attributes: this.parseAttributes(m[2] || ''),
                        name: (m[3] || '').trim()
                    };
                }
                continue;
            }

            if (!line || line.startsWith('#') || !currentItem) continue;

            currentItem.url = line;
            currentItem.logo = currentItem.attributes['tvg-logo'];

            /* ===== MERGE KEY ===== */
            const rawTvgId = currentItem.attributes['tvg-id'];
            let mergeKey;
            if (rawTvgId && rawTvgId.trim()) {
                mergeKey = normalize(rawTvgId);
            } else {
                mergeKey = normalize(
                    currentItem.name.replace(/\b(4K|UHD|FHD|HD|SD)\b/gi, '')
                );
            }

            const groupTitle = currentItem.attributes['group-title'] || '';
            currentItem.category = groupTitle;
            currentItem.epg_channel_id = mergeKey;

            /* ===== TYPE DETECTION ===== */
            const isMovie = /\(\d{4}\)/.test(currentItem.name);
            currentItem.type = isMovie ? 'movie' : 'tv';

            /* ===========================
               TV CHANNEL MERGE
               =========================== */
            if (currentItem.type === 'tv' && mergeKey) {
                const qm = currentItem.name.match(/\b(4K|UHD|FHD|HD|SD)\b/i);
                let quality = qm ? qm[1].toUpperCase() : 'SD';
                if (quality === 'UHD') quality = '4K';

                const baseName = currentItem.name
                    .replace(/\b(4K|UHD|FHD|HD|SD)\b/gi, '')
                    .replace(/\s+/g, ' ')
                    .trim();

                if (!channelGroups.has(mergeKey)) {
                    channelGroups.set(mergeKey, {
                        id: `iptv_${crypto.createHash('md5').update(mergeKey).digest('hex').slice(0, 16)}`,
                        name: baseName,
                        type: 'tv',
                        logo: currentItem.logo,
                        category: groupTitle,
                        epg_channel_id: mergeKey,
                        attributes: {
                            ...currentItem.attributes,
                            'tvg-id': mergeKey,
                            'group-title': groupTitle
                        },
                        streams: []
                    });
                }

                const ch = channelGroups.get(mergeKey);
                ch.streams.push({
                    quality,
                    url: currentItem.url,
                    title: `${baseName} [${quality}]`
                });

                const order = { '4K': 4, 'FHD': 3, 'HD': 2, 'SD': 1 };
                ch.streams.sort((a, b) => (order[b.quality] || 0) - (order[a.quality] || 0));
                ch.url = ch.streams[0].url;
            } else {
                currentItem.id = `iptv_${crypto.createHash('md5')
                    .update(currentItem.name + currentItem.url)
                    .digest('hex')
                    .slice(0, 16)}`;
                items.push(currentItem);
            }

            currentItem = null;
        }

        for (const ch of channelGroups.values()) items.push(ch);

        this.log.debug('M3U parsed', {
            total: items.length,
            channels: channelGroups.size
        });

        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const re = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = re.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    /* ===========================
       STREAM HANDLER
       =========================== */
    getStream(id) {
        const item = this.channels.find(c => c.id === id) ||
                     this.movies.find(m => m.id === id);
        if (!item) return null;

        if (item.streams && item.streams.length) {
            return item.streams.map(s => ({
                url: s.url,
                title: `${item.name} [${s.quality}]`,
                behaviorHints: { notWebReady: true }
            }));
        }

        return {
            url: item.url,
            title: item.name,
            behaviorHints: { notWebReady: true }
        };
    }

    generateMetaPreview(item) {
        return {
            id: item.id,
            type: item.type,
            name: item.name,
            poster: item.logo || item.attributes?.['tvg-logo'],
            description:
                item.type === 'tv'
                    ? `📺 Live Channel${item.streams?.length ? ` (${item.streams.length} qualities)` : ''}`
                    : 'Movie'
        };
    }
}

/* ===========================
   ADDON EXPORT
   =========================== */
module.exports = async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.1",
        name: ADDON_NAME,
        description: "IPTV addon (M3U / Xtream) with merged TV qualities",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie"],
        catalogs: [{
            type: "tv",
            id: "iptv_channels_all",
            name: "All TV Channels"
        }],
        idPrefixes: ["iptv_"]
    };

    const builder = new addonBuilder(manifest);
    const addon = new M3UEPGAddon(config, manifest);

    builder.defineCatalogHandler(async () => ({
        metas: addon.channels.map(c => addon.generateMetaPreview(c))
    }));

    builder.defineStreamHandler(async ({ id }) => ({
        streams: addon.getStream(id) || []
    }));

    builder.defineMetaHandler(async ({ id }) => ({
        meta: addon.channels.find(c => c.id === id)
    }));

    return builder.getInterface();
};
