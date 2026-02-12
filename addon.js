// IPTV Stremio Addon Core (with debug logging + series (shows) support for BOTH Xtream & Direct M3U)
// Version 1.4.0: Adds Direct M3U series grouping + per‑episode streams
require('dotenv').config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const LRUCache = require("./lruCache");
const fetch = require('node-fetch');

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
    } catch (e) {
        console.warn('[REDIS] ioredis not installed or failed, falling back to in-memory LRU');
        redisClient = null;
    }
}

const ADDON_NAME = "M3U/EPG TV Addon";
const ADDON_ID = "org.stremio.m3u-epg-addon";

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

const CACHE_ENABLED = (process.env.CACHE_ENABLED || 'true').toLowerCase() !== 'false';
const CACHE_TTL_MS = parseInt(process.env.CACHE_TTL_MS || (6 * 3600 * 1000).toString(), 10);
const MAX_CACHE_ENTRIES = parseInt(process.env.MAX_CACHE_ENTRIES || '300', 10);

const dataCache = new LRUCache({ max: MAX_CACHE_ENTRIES, ttl: CACHE_TTL_MS });
const buildPromiseCache = new Map();

async function redisGetJSON(key) {
    if (!redisClient) return null;
    try {
        const raw = await redisClient.get(key);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch { return null; }
}
async function redisSetJSON(key, value, ttl) {
    if (!redisClient) return;
    try {
        await redisClient.set(key, JSON.stringify(value), 'PX', ttl);
    } catch { /* ignore */ }
}

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
        includeSeries: config.includeSeries !== false // default true
    };
    return crypto.createHash('md5').update(stableStringify(minimal)).digest('hex');
}

class M3UEPGAddon {
    constructor(config = {}, manifestRef) {
        if (!config.provider) {
            config.provider = config.useXtream ? 'xtream' : 'direct';
        }
        this.providerName = config.provider === 'xtream' ? 'xtream' : 'direct';
        this.config = config;
        this.manifestRef = manifestRef;
        this.cacheKey = createCacheKey(config);
        this.updateInterval = 3600000;
        this.channels = []; // live TV
        this.movies = [];   // VOD movies
        this.series = [];   // Series (shows)
        this.seriesInfoCache = new Map(); // seriesId -> { videos: [...], fetchedAt }
        this.epgData = {};
        this.lastUpdate = 0;
        this.log = makeLogger(config.debug);

        // Direct provider may populate this (seriesId -> episodes array)
        this.directSeriesEpisodeIndex = new Map();

        if (typeof this.config.epgOffsetHours === 'string') {
            const n = parseFloat(this.config.epgOffsetHours);
            if (!isNaN(n)) this.config.epgOffsetHours = n;
        }
        if (typeof this.config.epgOffsetHours !== 'number' || !isFinite(this.config.epgOffsetHours))
            this.config.epgOffsetHours = 0;
        if (Math.abs(this.config.epgOffsetHours) > 48)
            this.config.epgOffsetHours = 0;
        if (typeof this.config.includeSeries === 'undefined')
            this.config.includeSeries = true;

        this.log.debug('Addon instance created', {
            provider: this.providerName,
            cacheKey: this.cacheKey,
            epgOffsetHours: this.config.epgOffsetHours,
            includeSeries: this.config.includeSeries
        });
    }

    async loadFromCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        let cached = dataCache.get(cacheKey);
        if (!cached && redisClient) {
            cached = await redisGetJSON(cacheKey);
            if (cached) dataCache.set(cacheKey, cached);
        }
        if (cached) {
            this.channels = cached.channels || [];
            this.movies = cached.movies || [];
            this.series = cached.series || [];
            this.epgData = cached.epgData || {};
            this.lastUpdate = cached.lastUpdate || 0;
            // Direct series episodes index is not persisted; rebuild on next fetch
            this.log.debug('Cache hit for data', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                lastUpdate: new Date(this.lastUpdate).toISOString()
            });
        }
    }

    async saveToCache() {
        if (!CACHE_ENABLED) return;
        const cacheKey = 'addon:data:' + this.cacheKey;
        const entry = {
            channels: this.channels,
            movies: this.movies,
            series: this.series,
            epgData: this.epgData,
            lastUpdate: this.lastUpdate
        };
        dataCache.set(cacheKey, entry);
        await redisSetJSON(cacheKey, entry, CACHE_TTL_MS);
        this.log.debug('Saved data to cache');
    }

   parseM3U(content) {
    const startTs = Date.now();
    const lines = content.split('\n');
    const items = [];
    const channelGroups = new Map(); // normalized tvg-id -> channel
    let currentItem = null;

    const normalize = (v) =>
        typeof v === 'string' ? v.trim().toLowerCase() : '';

    for (const raw of lines) {
        const line = raw.trim();

        if (line.startsWith('#EXTINF:')) {
            const matches = line.match(/#EXTINF:(-?\d+)(?:\s+(.*))?,(.*)/);
            if (matches) {
                currentItem = {
                    duration: parseInt(matches[1], 10),
                    attributes: this.parseAttributes(matches[2] || ''),
                    name: (matches[3] || '').trim()
                };
            }
            continue;
        }

        if (!line || line.startsWith('#') || !currentItem) continue;

        currentItem.url = line;
        currentItem.logo = currentItem.attributes['tvg-logo'];

        const rawTvgId =
            currentItem.attributes['tvg-id'] ||
            currentItem.attributes['tvg-name'] ||
            '';

        const normalizedTvgId = normalize(rawTvgId);
        const groupTitleRaw = currentItem.attributes['group-title'] || '';
        const groupTitleNorm = normalize(groupTitleRaw);

        currentItem.epg_channel_id = normalizedTvgId;
        currentItem.category = groupTitleRaw;

        const nameLower = currentItem.name.toLowerCase();

        const isMovie =
            groupTitleNorm.includes('movie') ||
            this.isMovieFormat(currentItem.name);

        const isSeries =
            !isMovie &&
            (
                groupTitleNorm.includes('series') ||
                /\bS\d{1,2}E\d{1,2}\b/i.test(currentItem.name) ||
                /\bSeason\s?\d+/i.test(currentItem.name)
            );

        currentItem.type = isSeries ? 'series' : (isMovie ? 'movie' : 'tv');

        /* ===========================
           TV CHANNEL MERGE (FIXED)
           =========================== */
        if (currentItem.type === 'tv' && normalizedTvgId) {
            const qualityMatch = currentItem.name.match(/\b(4K|UHD|FHD|HD|SD)\b/i);
            let quality = qualityMatch ? qualityMatch[1].toUpperCase() : 'SD';
            if (quality === 'UHD') quality = '4K';

            const baseName = currentItem.name
                .replace(/\b(4K|UHD|FHD|HD|SD)\b/gi, '')
                .replace(/\s{2,}/g, ' ')
                .trim();

            const key = normalizedTvgId;

            if (!channelGroups.has(key)) {
                channelGroups.set(key, {
                    id: `iptv_${crypto.createHash('md5').update(key).digest('hex').slice(0, 16)}`,
                    name: baseName,
                    type: 'tv',
                    logo: currentItem.logo,
                    category: groupTitleRaw,
                    epg_channel_id: normalizedTvgId,
                    attributes: {
                        ...currentItem.attributes,
                        'tvg-id': normalizedTvgId,
                        'group-title': groupTitleRaw
                    },
                    streams: []
                });
            }

            const channel = channelGroups.get(key);

            channel.streams.push({
                quality,
                url: currentItem.url,
                title: `${baseName} [${quality}]`
            });

            const order = { '4K': 4, 'FHD': 3, 'HD': 2, 'SD': 1 };
            channel.streams.sort((a, b) => (order[b.quality] || 0) - (order[a.quality] || 0));

            channel.url = channel.streams[0].url;
        } else {
            /* Movies / Series */
            currentItem.id = `iptv_${crypto.createHash('md5')
                .update(currentItem.name + currentItem.url)
                .digest('hex')
                .slice(0, 16)}`;
            items.push(currentItem);
        }

        currentItem = null;
    }

    for (const ch of channelGroups.values()) {
        items.push(ch);
    }

    this.log.debug('M3U parsed (normalized)', {
        lines: lines.length,
        items: items.length,
        channels: channelGroups.size,
        ms: Date.now() - startTs
    });

    return items;
}


    parseAttributes(str) {
        const attrs = {};
        const regex = /(\w+(?:-\w+)*)="([^"]*)"/g;
        let m;
        while ((m = regex.exec(str)) !== null) attrs[m[1]] = m[2];
        return attrs;
    }

    isMovieFormat(name) {
         // Sadece yıla göre filmleri algıla, kalite etiketlerine göre değil
        return /\(\d{4}\)/.test(name);
    }

    async parseEPG(content) {
        const start = Date.now();
        try {
            const xml2js = require('xml2js');
            const parser = new xml2js.Parser();
            const result = await parser.parseStringPromise(content);
            const epgData = {};
            if (result.tv && result.tv.programme) {
                for (const prog of result.tv.programme) {
                    const ch = prog.$.channel;
                    if (!epgData[ch]) epgData[ch] = [];
                    epgData[ch].push({
                        start: prog.$.start,
                        stop: prog.$.stop,
                        title: prog.title ? prog.title[0]._ || prog.title[0] : 'Unknown',
                        desc: prog.desc ? prog.desc[0]._ || prog.desc[0] : ''
                    });
                }
            }
            this.log.debug('EPG parsed', {
                channels: Object.keys(epgData).length,
                programmes: Object.values(epgData).reduce((a, b) => a + b.length, 0),
                ms: Date.now() - start
            });
            return epgData;
        } catch (e) {
            this.log.warn('EPG parse failed', e.message);
            return {};
        }
    }

    parseEPGTime(s) {
        if (!s) return new Date();
        const m = s.match(/^(\d{14})(?:\s*([+\-]\d{4}))?/);
        if (m) {
            const base = m[1];
            const tz = m[2] || null;
            const year = parseInt(base.slice(0, 4), 10);
            const month = parseInt(base.slice(4, 6), 10) - 1;
            const day = parseInt(base.slice(6, 8), 10);
            const hour = parseInt(base.slice(8, 10), 10);
            const min = parseInt(base.slice(10, 12), 10);
            const sec = parseInt(base.slice(12, 14), 10);
            let date;
            if (tz) {
                const iso = `${year}-${(month + 1).toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}${tz}`;
                const parsed = new Date(iso);
                if (!isNaN(parsed.getTime())) date = parsed;
            }
            if (!date) date = new Date(year, month, day, hour, min, sec);
            if (this.config.epgOffsetHours) {
                date = new Date(date.getTime() + this.config.epgOffsetHours * 3600000);
            }
            return date;
        }
        const d = new Date(s);
        if (this.config.epgOffsetHours && !isNaN(d.getTime()))
            return new Date(d.getTime() + this.config.epgOffsetHours * 3600000);
        return d;
    }

    getCurrentProgram(channelId) {
        if (!channelId || !this.epgData[channelId]) return null;
        const now = new Date();
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            const stop = this.parseEPGTime(p.stop);
            if (now >= start && now <= stop) {
                return { title: p.title, description: p.desc, start, stop, startTime: start, stopTime: stop };
            }
        }
        return null;
    }

    getUpcomingPrograms(channelId, limit = 5) {
        if (!channelId || !this.epgData[channelId]) return [];
        const now = new Date();
        const upcoming = [];
        for (const p of this.epgData[channelId]) {
            const start = this.parseEPGTime(p.start);
            if (start > now && upcoming.length < limit) {
                upcoming.push({
                    title: p.title,
                    description: p.desc,
                    startTime: start,
                    stopTime: this.parseEPGTime(p.stop)
                });
            }
        }
        return upcoming.sort((a, b) => a.startTime - b.startTime);
    }

    async ensureSeriesInfo(seriesId) {
        if (!seriesId) return null;
        if (this.seriesInfoCache.has(seriesId)) return this.seriesInfoCache.get(seriesId);

        try {
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            if (typeof providerModule.fetchSeriesInfo === 'function') {
                const info = await providerModule.fetchSeriesInfo(this, seriesId);
                this.seriesInfoCache.set(seriesId, info);
                return info;
            }
        } catch (e) {
            this.log.warn('Series info fetch failed', seriesId, e.message);
        }
        // Fallback empty structure
        const empty = { videos: [] };
        this.seriesInfoCache.set(seriesId, empty);
        return empty;
    }

    async updateData(force = false) {
        const now = Date.now();
        if (!force && CACHE_ENABLED) {
            if (this.lastUpdate && now - this.lastUpdate < this.updateInterval) {
                this.log.debug('Skip update (global interval)');
                return;
            }
            if ((this.channels.length || this.movies.length || this.series.length) && now - this.lastUpdate < 900000) {
                this.log.debug('Skip update (recent minor interval)');
                return;
            }
        }
        try {
            const start = Date.now();
            const providerModule = require(`./src/js/providers/${this.providerName}Provider.js`);
            await providerModule.fetchData(this);
            this.lastUpdate = Date.now();
            if (CACHE_ENABLED) await this.saveToCache();
            this.buildGenresInManifest();
            this.log.debug('Data update complete', {
                channels: this.channels.length,
                movies: this.movies.length,
                series: this.series.length,
                ms: Date.now() - start
            });
        } catch (e) {
            this.log.error('[UPDATE] Failed:', e.message);
        }
    }

    deriveFallbackLogoUrl(item) {
        const logoAttr = item.attributes?.['tvg-logo'];
        if (logoAttr && logoAttr.trim()) return logoAttr;
        const tvgId = item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        if (!tvgId)
            return `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
        return `logo/${encodeURIComponent(tvgId)}.png`;
    }

    generateMetaPreview(item) {
    const meta = { id: item.id, type: item.type, name: item.name };
    if (item.type === 'tv') {
        const epgId = item.epg_channel_id || item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        const current = this.getCurrentProgram(epgId);
        meta.description = current
            ? `📡 Now: ${current.title}${current.description ? `\n${current.description}` : ''}`
            : '📡 Live Channel';
        
        // Logo'yu item'dan direkt al (parseM3U'da zaten set edilmiş)
        meta.poster = item.logo || item.attributes?.['tvg-logo'] || 
            `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`;
        
        meta.genres = item.category
            ? [item.category]
            : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']);
        meta.runtime = 'Live';
        
        // Eğer birden fazla kalite varsa bunu belirt
        if (item.streams && item.streams.length > 1) {
            meta.description = `🎬 ${item.streams.length} quality options available\n\n` + meta.description;
        }
    } else if (item.type === 'movie') {
        meta.poster = item.poster ||
            item.attributes?.['tvg-logo'] ||
            `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`;
        meta.year = item.year;
        if (!meta.year) {
            const m = item.name.match(/\((\d{4})\)/);
            if (m) meta.year = parseInt(m[1]);
        }
        meta.description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
        meta.genres = item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'];
    } else if (item.type === 'series') {
        meta.poster = item.poster ||
            item.attributes?.['tvg-logo'] ||
            `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(item.name)}`;
        meta.description = item.plot || item.attributes?.['plot'] || 'Series / Show';
        meta.genres = item.category
            ? [item.category]
            : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Series']);
    }
    return meta;
}

getStream(id) {
    // Episode streams
    if (id.startsWith('iptv_series_ep_')) {
        const epEntry = this.lookupEpisodeById(id);
        if (!epEntry) return null;
        return {
            url: epEntry.url,
            title: `${epEntry.title || 'Episode'}${epEntry.season ? ` S${epEntry.season}E${epEntry.episode}` : ''}`,
            behaviorHints: { notWebReady: true }
        };
    }

    const all = [...this.channels, ...this.movies];
    const item = all.find(i => i.id === id);
    if (!item) return null;

    // Eğer item birden fazla stream varsa (TV kanalları için), hepsini döndür
    if (item.streams && item.streams.length > 0) {
        return item.streams.map(stream => ({
            url: stream.url,
            title: `${item.name} [${stream.quality}]`,
            name: stream.quality,
            behaviorHints: { notWebReady: true }
        }));
    }

    // Tek stream için eski format
    return {
        url: item.url,
        title: item.type === 'tv' ? `${item.name} - Live` : item.name,
        behaviorHints: { notWebReady: true }
    };
}

    lookupEpisodeById(epId) {
        // Check cached series info
        for (const [, info] of this.seriesInfoCache.entries()) {
            if (info && Array.isArray(info.videos)) {
                const found = info.videos.find(v => v.id === epId);
                if (found) return found;
            }
        }
        // Direct provider inline index
        for (const arr of this.directSeriesEpisodeIndex.values()) {
            const found = arr.find(v => v.id === epId);
            if (found) return found;
        }
        return null;
    }

    async buildSeriesMeta(seriesItem) {
        const seriesIdRaw = seriesItem.series_id || seriesItem.id.replace(/^iptv_series_/, '');
        const info = await this.ensureSeriesInfo(seriesIdRaw);
        const videos = (info?.videos || []).map(v => ({
            id: v.id,
            title: v.title,
            season: v.season,
            episode: v.episode,
            released: v.released || null,
            thumbnail: v.thumbnail || seriesItem.poster || seriesItem.attributes?.['tvg-logo']
        }));

        return {
            id: seriesItem.id,
            type: 'series',
            name: seriesItem.name,
            poster: seriesItem.poster ||
                seriesItem.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/3366CC/FFFFFF?text=${encodeURIComponent(seriesItem.name)}`,
            description: seriesItem.plot || seriesItem.attributes?.['plot'] || 'Series / Show',
            genres: seriesItem.category
                ? [seriesItem.category]
                : (seriesItem.attributes?.['group-title'] ? [seriesItem.attributes['group-title']] : ['Series']),
            videos
        };
    }

    async getDetailedMetaAsync(id, type) {
        if (type === 'series' || id.startsWith('iptv_series_')) {
            const seriesItem = this.series.find(s => s.id === id);
            if (!seriesItem) return null;
            return await this.buildSeriesMeta(seriesItem);
        }
        // fallback sync path
        return this.getDetailedMeta(id);
    }

getDetailedMeta(id) {
    const all = [...this.channels, ...this.movies];
    const item = all.find(i => i.id === id);
    if (!item) return null;
    if (item.type === 'tv') {
        // epg_channel_id'yi önce kontrol et (parseM3U'da set edilmiş)
        const epgId = item.epg_channel_id || item.attributes?.['tvg-id'] || item.attributes?.['tvg-name'];
        const current = this.getCurrentProgram(epgId);
        const upcoming = this.getUpcomingPrograms(epgId, 3);
        let description = `📺 CHANNEL: ${item.name}`;
        
        // Birden fazla kalite varsa bunu ekle
        if (item.streams && item.streams.length > 1) {
            description += `\n🎬 ${item.streams.length} quality options available`;
        }
        
        if (current) {
            const start = current.startTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
            const end = current.stopTime?.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) || '';
            description += `\n\n📡 NOW: ${current.title}${start && end ? ` (${start}-${end})` : ''}`;
            if (current.description) description += `\n\n${current.description}`;
        }
        if (upcoming.length) {
            description += '\n\n📅 UPCOMING:\n';
            for (const p of upcoming) {
                description += `${p.startTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} - ${p.title}\n`;
            }
        }
        return {
            id: item.id,
            type: 'tv',
            name: item.name,
            // Logo'yu item'dan direkt al
            poster: item.logo || item.attributes?.['tvg-logo'] || 
                `https://via.placeholder.com/300x400/333333/FFFFFF?text=${encodeURIComponent(item.name)}`,
            description,
            genres: item.category
                ? [item.category]
                : (item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Live TV']),
            runtime: 'Live'
        };
    } else {
        let year = item.year;
        if (!year) {
            const m = item.name.match(/\((\d{4})\)/);
            if (m) year = parseInt(m[1]);
        }
        const description = item.plot || item.attributes?.['plot'] || `Movie: ${item.name}`;
        return {
            id: item.id,
            type: 'movie',
            name: item.name,
            poster: item.poster || item.attributes?.['tvg-logo'] ||
                `https://via.placeholder.com/300x450/CC6600/FFFFFF?text=${encodeURIComponent(item.name)}`,
            description,
            genres: item.attributes?.['group-title'] ? [item.attributes['group-title']] : ['Movie'],
            year
        };
    }
}
}

async function createAddon(config) {
    const manifest = {
        id: ADDON_ID,
        version: "2.1.0", // Versiyon yükselttik
        name: ADDON_NAME,
        description: "IPTV addon (M3U / EPG / Xtream) with encrypted configs, caching & series support (Xtream + Direct)",
        resources: ["catalog", "stream", "meta"],
        types: ["tv", "movie", "series"],
        catalogs: [], // Boş başlat, dinamik olarak dolduracağız
        idPrefixes: ["iptv_"],
        behaviorHints: {
            configurable: true,
            configurationRequired: false
        }
    };

    config.instanceId = config.instanceId ||
        (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(8).toString('hex'));

    const cacheKey = createCacheKey(config);
    const debugFlag = !!config.debug || DEBUG_ENV;
    if (debugFlag) {
        console.log('[DEBUG] createAddon start', { cacheKey, provider: config.provider, includeSeries: config.includeSeries !== false });
    } else {
        console.log(`[ADDON] Cache ${CACHE_ENABLED ? 'ENABLED' : 'DISABLED'} for config ${cacheKey}`);
    }

    if (CACHE_ENABLED && buildPromiseCache.has(cacheKey)) {
        if (debugFlag) console.log('[DEBUG] Reusing build promise', cacheKey);
        return buildPromiseCache.get(cacheKey);
    }

    const buildPromise = (async () => {
        const builder = new addonBuilder(manifest);
        const addonInstance = new M3UEPGAddon(config, manifest);
        await addonInstance.loadFromCache();
        await addonInstance.updateData(true);
        
        // Kategorileri topla
        const tvCategories = [
            ...new Set(
                addonInstance.channels
                    .map(c => c.category || c.attributes?.['group-title'])
                    .filter(Boolean)
                    .map(s => s.trim())
            )
        ].sort((a, b) => a.localeCompare(b));

        const movieCategories = [
            ...new Set(
                addonInstance.movies
                    .map(c => c.category || c.attributes?.['group-title'])
                    .filter(Boolean)
                    .map(s => s.trim())
            )
        ].sort((a, b) => a.localeCompare(b));

        const seriesCategories = [
            ...new Set(
                addonInstance.series
                    .map(c => c.category || c.attributes?.['group-title'])
                    .filter(Boolean)
                    .map(s => s.trim())
            )
        ].sort((a, b) => a.localeCompare(b));

        // TV katalogları oluştur
        // "All Channels" katalogu
        manifest.catalogs.push({
            type: 'tv',
            id: 'iptv_channels_all',
            name: 'All TV Channels',
            extra: [{ name: 'search' }, { name: 'skip' }]
        });

        // Her kategori için ayrı katalog
        tvCategories.forEach((category, index) => {
            // Güvenli ID oluştur (özel karakterleri temizle)
            const safeId = category
                .toLowerCase()
                .replace(/[^a-z0-9]/g, '_')
                .replace(/_+/g, '_')
                .replace(/^_|_$/g, '');
            
            manifest.catalogs.push({
                type: 'tv',
                id: `iptv_tv_${safeId}`,
                name: category,
                extra: [{ name: 'search' }, { name: 'skip' }]
            });
        });

        // Film katalogları
        if (addonInstance.movies.length > 0) {
            manifest.catalogs.push({
                type: 'movie',
                id: 'iptv_movies_all',
                name: 'All Movies',
                extra: [{ name: 'search' }, { name: 'skip' }]
            });

            movieCategories.forEach(category => {
                const safeId = category
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_|_$/g, '');
                
                manifest.catalogs.push({
                    type: 'movie',
                    id: `iptv_movie_${safeId}`,
                    name: category,
                    extra: [{ name: 'search' }, { name: 'skip' }]
                });
            });
        }

        // Dizi katalogları
        if (addonInstance.config.includeSeries !== false && addonInstance.series.length > 0) {
            manifest.catalogs.push({
                type: 'series',
                id: 'iptv_series_all',
                name: 'All Series',
                extra: [{ name: 'search' }, { name: 'skip' }]
            });

            seriesCategories.forEach(category => {
                const safeId = category
                    .toLowerCase()
                    .replace(/[^a-z0-9]/g, '_')
                    .replace(/_+/g, '_')
                    .replace(/^_|_$/g, '');
                
                manifest.catalogs.push({
                    type: 'series',
                    id: `iptv_series_${safeId}`,
                    name: category,
                    extra: [{ name: 'search' }, { name: 'skip' }]
                });
            });
        }

        addonInstance.log.debug('Dynamic catalogs created', {
            tvCatalogs: tvCategories.length + 1,
            movieCatalogs: movieCategories.length + 1,
            seriesCatalogs: seriesCategories.length + 1,
            totalCatalogs: manifest.catalogs.length
        });

        builder.defineCatalogHandler(async (args) => {
            const start = Date.now();
            try {
                addonInstance.updateData().catch(() => { });
                let items = [];
                let categoryFilter = null;

                // Catalog ID'den kategoriyi çıkar
                if (args.id.startsWith('iptv_tv_') && args.id !== 'iptv_channels_all') {
                    items = addonInstance.channels;
                    // ID'den kategori adını bul
                    const catalogDef = manifest.catalogs.find(c => c.id === args.id);
                    if (catalogDef) {
                        categoryFilter = catalogDef.name;
                    }
                } else if (args.id === 'iptv_channels_all') {
                    items = addonInstance.channels;
                } else if (args.id.startsWith('iptv_movie_') && args.id !== 'iptv_movies_all') {
                    items = addonInstance.movies;
                    const catalogDef = manifest.catalogs.find(c => c.id === args.id);
                    if (catalogDef) {
                        categoryFilter = catalogDef.name;
                    }
                } else if (args.id === 'iptv_movies_all') {
                    items = addonInstance.movies;
                } else if (args.id.startsWith('iptv_series_') && args.id !== 'iptv_series_all') {
                    if (addonInstance.config.includeSeries !== false) {
                        items = addonInstance.series;
                        const catalogDef = manifest.catalogs.find(c => c.id === args.id);
                        if (catalogDef) {
                            categoryFilter = catalogDef.name;
                        }
                    }
                } else if (args.id === 'iptv_series_all') {
                    if (addonInstance.config.includeSeries !== false)
                        items = addonInstance.series;
                }

                // Kategori filtresi uygula
                if (categoryFilter) {
                    items = items.filter(i =>
                        (i.category && i.category === categoryFilter) ||
                        (i.attributes && i.attributes['group-title'] === categoryFilter)
                    );
                }

                // Arama filtresi
                const extra = args.extra || {};
                if (extra.search) {
                    const q = extra.search.toLowerCase();
                    items = items.filter(i => i.name.toLowerCase().includes(q));
                }

                const metas = items.slice(0, 200).map(i => addonInstance.generateMetaPreview(i));
                
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Catalog handler', {
                        type: args.type,
                        id: args.id,
                        category: categoryFilter,
                        totalItems: items.length,
                        returned: metas.length,
                        ms: Date.now() - start
                    });
                }
                
                return { metas };
            } catch (e) {
                console.error('[CATALOG] Error', e);
                return { metas: [] };
            }
        });

        builder.defineStreamHandler(async ({ type, id }) => {
            try {
                const streamData = addonInstance.getStream(id);
                if (!streamData) return { streams: [] };
                
                const streams = Array.isArray(streamData) ? streamData : [streamData];
                
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Stream request', { id, streamCount: streams.length });
                }
                
                return { streams };
            } catch (e) {
                console.error('[STREAM] Error', e);
                return { streams: [] };
            }
        });

        builder.defineMetaHandler(async ({ type, id }) => {
            try {
                if (type === 'series' || id.startsWith('iptv_series_')) {
                    const meta = await addonInstance.getDetailedMetaAsync(id, 'series');
                    if (addonInstance.config.debug) {
                        console.log('[DEBUG] Series meta request', { id, videos: meta?.videos?.length });
                    }
                    return { meta };
                }
                const meta = addonInstance.getDetailedMeta(id);
                if (addonInstance.config.debug) {
                    console.log('[DEBUG] Meta request', { id, type });
                }
                return { meta };
            } catch (e) {
                console.error('[META] Error', e);
                return { meta: null };
            }
        });

        return builder.getInterface();
    })();

    if (CACHE_ENABLED) buildPromiseCache.set(cacheKey, buildPromise);
    try {
        const iface = await buildPromise;
        return iface;
    } finally {
        // Keep promise cached
    }
}

module.exports = createAddon;
