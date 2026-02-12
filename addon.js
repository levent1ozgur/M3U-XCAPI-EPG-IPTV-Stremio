// IPTV Stremio Addon Core (FIXED & NORMALIZED)
// Version 1.4.1 – TV channel merge + quality streams FIXED

require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

/* =========================
   LOGGING
========================= */
const DEBUG_ENV = (process.env.DEBUG_MODE || '').toLowerCase() === 'true';
function makeLogger(cfgDebug) {
    const enabled = !!cfgDebug || DEBUG_ENV;
    return {
        debug: (...a) => { if (enabled) console.log('[DEBUG]', ...a); },
        info:  (...a) => console.log('[INFO]', ...a),
        warn:  (...a) => console.warn('[WARN]', ...a),
        error: (...a) => console.error('[ERROR]', ...a)
    };
}

/* =========================
   CACHE
========================= */
const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = 6 * 3600 * 1000;
const dataCache = new LRUCache({ max: 300, ttl: CACHE_TTL_MS });

function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}
function createCacheKey(config) {
    return crypto.createHash('md5')
        .update(stableStringify({
            provider: config.provider,
            m3uUrl: config.m3uUrl,
            xtreamUrl: config.xtreamUrl,
            xtreamUsername: config.xtreamUsername
        }))
        .digest('hex');
}

/* =========================
   ADDON CLASS
========================= */
class M3UEPGAddon {
    constructor(config = {}) {
        this.config = config;
        this.cacheKey = createCacheKey(config);
        this.channels = [];
        this.movies = [];
        this.series = [];
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);
    }

    /* =========================
       M3U PARSER (FIXED)
    ========================= */
    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        const channelGroups = new Map();
        let currentItem = null;

        const normalize = s =>
            typeof s === 'string' ? s.trim().toLowerCase() : '';

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

            const rawTvgId = currentItem.attributes['tvg-id'];

            const mergeKey = rawTvgId && rawTvgId.trim()
                ? normalize(rawTvgId)
                : normalize(
                    currentItem.name
                        .replace(/\b(4K|UHD|FHD|HD|SD)\b/gi, '')
                        .trim()
                );

            currentItem.epg_channel_id = mergeKey;
            currentItem.category = currentItem.attributes['group-title'] || '';

            /* ---------- TV CHANNEL ---------- */
            if (mergeKey) {
                const qualityMatch = currentItem.name.match(/\b(4K|UHD|FHD|HD|SD)\b/i);
                let quality = qualityMatch ? qualityMatch[1].toUpperCase() : 'SD';
                if (quality === 'UHD') quality = '4K';

                const baseName = currentItem.name
                    .replace(/\b(4K|UHD|FHD|HD|SD)\b/gi, '')
                    .replace(/\s{2,}/g, ' ')
                    .trim();

                if (!channelGroups.has(mergeKey)) {
                    channelGroups.set(mergeKey, {
                        id: `iptv_${crypto.createHash('md5').update(mergeKey).digest('hex').slice(0, 16)}`,
                        type: 'tv',
                        name: baseName,
                        logo: currentItem.logo,
                        category: currentItem.category,
                        epg_channel_id: mergeKey,
                        streams: []
                    });
                }

                const channel = channelGroups.get(mergeKey);

                channel.streams.push({
                    quality,
                    url: currentItem.url,
                    title: `${baseName} [${quality}]`
                });

                const order = { '4K': 4, 'FHD': 3, 'HD': 2, 'SD': 1 };
                channel.streams.sort((a, b) =>
                    (order[b.quality] || 0) - (order[a.quality] || 0)
                );

                channel.url = channel.streams[0].url;
            }

            currentItem = null;
        }

        for (const ch of channelGroups.values()) {
            items.push(ch);
        }

        this.log.debug('M3U parsed', {
            channels: channelGroups.size,
            items: items.length
        });

        return items;
    }

    parseAttributes(str) {
        const attrs = {};
        const re = /([\w-]+)="([^"]*)"/g;
        let m;
        while ((m = re.exec(str))) attrs[m[1]] = m[2];
        return attrs;
    }

    /* =========================
       STREAM HANDLER
    ========================= */
    getStream(id) {
        const item = this.channels.find(c => c.id === id);
        if (!item) return null;

        return item.streams.map(s => ({
            url: s.url,
            title: s.title,
            behaviorHints: { notWebReady: true }
        }));
    }

    generateMetaPreview(item) {
        return {
            id: item.id,
            type: 'tv',
            name: item.name,
            poster: item.logo || `https://via.placeholder.com/300x400?text=${encodeURIComponent(item.name)}`,
            genres: [item.category || 'Live TV']
        };
    }
}

/* =========================
   ADDON FACTORY
========================= */
async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.1",
        name: ADDON_NAME,
        description: "IPTV M3U addon with proper channel merge",
        resources: ["catalog", "stream"],
        types: ["tv"],
        catalogs: [{
            type: 'tv',
            id: 'iptv_all',
            name: 'All Channels'
        }],
        idPrefixes: ["iptv_"]
    };

    const builder = new addonBuilder(manifest);
    const addon = new M3UEPGAddon(config);

    builder.defineCatalogHandler(async () => {
        const metas = addon.channels.map(c => addon.generateMetaPreview(c));
        return { metas };
    });

    builder.defineStreamHandler(async ({ id }) => {
        const streams = addon.getStream(id);
        return { streams: streams || [] };
    });

    // DATA LOAD
    const res = await fetch(config.m3uUrl);
    const m3u = await res.text();
    addon.channels = addon.parseM3U(m3u);

    return builder.getInterface();
}

module.exports = createAddon;
