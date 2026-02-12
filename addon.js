// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0 → internal, Manifest v2.1.0
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

/* ===================== REDIS / CACHE ===================== */

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
        console.warn('[REDIS] ioredis not available, using in-memory LRU only');
        redisClient = null;
    }
}

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { }
}

/* ===================== LOGGING ===================== */

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

/* ===================== MANIFEST CONST ===================== */

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

/* ===================== HELPERS ===================== */

function stableStringify(obj) {
    return JSON.stringify(obj, Object.keys(obj).sort());
}

function createCacheKey(config) {
    const minimal = {
        provider: config.provider,
        m3uUrl: config.m3uUrl,
        epgUrl: config.epgUrl,
        enableEpg: !!config.enableEpg,
        xtreamUrl: config.xtreamUrl,
        xtreamUsername: config.xtreamUsername,
        xtreamUseM3U: !!config.xtreamUseM3U,
        xtreamOutput: config.xtreamOutput,
        epgOffsetHours: config.epgOffsetHours,
        includeSeries: config.includeSeries !== false
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

/* ===================== CORE CLASS ===================== */

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider)
            config.provider = config.useXtream ? 'xtream' : 'direct';

        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);

        this.channels = [];
        this.movies = [];
        this.series = [];

        this.seriesInfoCache = new Map();
        this.directSeriesEpisodeIndex = new Map();

        this.epgData = {};
        this.lastUpdate = 0;
        this.updateInterval = 3600000;

        this.log = makeLogger(config.debug);

        if (typeof this.config.epgOffsetHours !== 'number')
            this.config.epgOffsetHours = 0;

        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            includeSeries: this.config.includeSeries
        });
    }

    /* ===================== CACHE ===================== */

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const key = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(key);

        if (!cached && redisClient) {
            cached = await redisGetJSON(key);
            if (cached) dataCache.set(key, cached);
        }

        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            this.log.debug('Cache hit', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length
            });
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const key = 'addon:data:' + this.cacheKey;
        const entry = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(key, entry);
        await redisSetJSON(key, entry, CACHE_TTL_MS);
    }

    /* ===================== M3U PARSER ===================== */

    parseAttributes(str) {
        const attrs = {};
        const re = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = re.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
        return /\(\d{4}\)/.test(name);
    }

    parseM3U(content) {
        const lines = content.split('\n');
        const items = [];
        const channelGroups = new Map();
        let currentItem = null;

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
            } else if (line && !line.startsWith('#') && currentItem) {
                currentItem.url = line;
                currentItem.logo = currentItem.attributes['tvg-logo'];
                currentItem.epg_channel_id =
                    currentItem.attributes['tvg-id'] ||
                    currentItem.attributes['tvg-name'];
                currentItem.category = currentItem.attributes['group-title'];

                const group = (currentItem.category || '').toLowerCase();
                const lower = currentItem.name.toLowerCase();

                const isMovie =
                    group.includes('movie') ||
                    lower.includes('movie') ||
                    this.isMovieFormat(currentItem.name);

                const isSeries = !isMovie && (
                    group.includes('series') ||
                    group.includes('show') ||
                    /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name)
                );

                currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');

                if (currentItem.type === 'tv' && currentItem.epg_channel_id) {
                    const key = currentItem.epg_channel_id;
                    const qualityMatch = currentItem.name.match(/\b(4K|FHD|HD|SD)\b/i);
                    const quality = qualityMatch ? qualityMatch[1].toUpperCase() : 'SD';
                    const baseName = currentItem.name.replace(/\b(4K|FHD|HD|SD)\b/gi, '').trim();

                    if (!channelGroups.has(key)) {
                        channelGroups.set(key, {
                            id: `iptv_${crypto.createHash('md5').update(key).digest('hex').slice(0, 16)}`,
                            name: baseName,
                            type: 'tv',
                            category: currentItem.category,
                            logo: currentItem.logo,
                            epg_channel_id: currentItem.epg_channel_id,
                            attributes: currentItem.attributes,
                            streams: []
                        });
                    }

                    const ch = channelGroups.get(key);
                    ch.streams.push({
                        quality,
                        url: currentItem.url,
                        name: currentItem.name
                    });

                    const qOrder = { '4K': 4, 'FHD': 3, 'HD': 2, 'SD': 1 };
                    ch.streams.sort((a, b) => (qOrder[b.quality] || 0) - (qOrder[a.quality] || 0));
                    ch.url = ch.streams[0].url;
                } else {
                    currentItem.id =
                        `iptv_${crypto.createHash('md5')
                            .update(currentItem.name + currentItem.url)
                            .digest('hex')
                            .slice(0, 16)}`;
                    items.push(currentItem);
                }
                currentItem = null;
            }
        }

        for (const ch of channelGroups.values()) items.push(ch);
        return items;
    }

    /* ===================== UPDATE ===================== */

    async updateData(force = false) {
        const now = Date.now();
        if (!force && this.lastUpdate && now - this.lastUpdate < this.updateInterval)
            return;

        const provider = require(`./src/js/providers/${this.providerName}Provider.js`);
        await provider.fetchData(this);

        this.lastUpdate = Date.now();
        if (CACHE_ENABLED) await this.saveToCache();
    }

    /* ===================== META / STREAM ===================== */

    generateMetaPreview(item) {
        return {
            id: item.id,
            type: item.type,
            name: item.name,
            poster: item.logo || item.attributes?.['tvg-logo'],
            genres: item.category ? [item.category] : undefined
        };
    }

    getStream(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
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

    getDetailedMeta(id) {
        const all = [...this.channels, ...this.movies];
        const item = all.find(i => i.id === id);
        if (!item) return null;
        return this.generateMetaPreview(item);
    }
}

/* ===================== ADDON FACTORY ===================== */

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.0",
        name: ADDON_NAME,
        description: "IPTV addon (M3U / EPG / Xtream) with caching & series support",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [],
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    const cacheKey = createCacheKey(config);
    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey))
        return buildPromiseCache.get(cacheKey);

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addon = new M3UEPGAddon(config, manifest);

        await addon.loadFromCache();
        await addon.updateData(true);

        manifest.catalogs.push({
            type: 'tv',
            id: 'iptv_channels_all',
            name: 'All TV Channels',
            extra: [{ name: 'search' }, { name: 'skip' }]
        });

        builder.defineCatalogHandler(async () => ({
            metas: addon.channels.slice(0, 200).map(i => addon.generateMetaPreview(i))
        }));

        builder.defineStreamHandler(async ({ id }) => {
            const s = addon.getStream(id);
            return { streams: s ? (Array.isArray(s) ? s : [s]) : [] };
        });

        builder.defineMetaHandler(async ({ id }) => ({
            meta: addon.getDetailedMeta(id)
        }));

        return builder.getInterface();
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    return buildPromise;
}

module.exports = createAddon;
