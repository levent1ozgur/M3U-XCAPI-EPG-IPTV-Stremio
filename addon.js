require("dotenv").config();

const { addonBuilder } = require("stremio-addon-sdk");
const crypto = require("crypto");
const fetch = require("node-fetch");

/* =========================
   CONFIG
========================= */
const ADDON_ID = "org.stremio.m3u.tv";
const ADDON_NAME = "M3U IPTV TV Addon";

/* =========================
   MANIFEST
========================= */
const manifest = {
    id: ADDON_ID,
    version: "1.0.0",
    name: ADDON_NAME,
    description: "Merged IPTV channels with quality streams",
    resources: ["catalog", "stream"],
    types: ["tv"],
    catalogs: [
        {
            type: "tv",
            id: "iptv",
            name: "IPTV",
            extra: []
        }
    ]
};

const builder = new addonBuilder(manifest);

/* =========================
   M3U PARSER
========================= */
function parseM3U(content) {
    const lines = content.split("\n");
    const channels = new Map();
    let current = null;

    const normalize = s => s.trim().toLowerCase();

    for (const raw of lines) {
        const line = raw.trim();

        if (line.startsWith("#EXTINF")) {
            const name = line.split(",").pop().trim();
            const tvgIdMatch = line.match(/tvg-id="([^"]+)"/i);
            const tvgId = tvgIdMatch ? tvgIdMatch[1] : null;

            current = { name, tvgId };
            continue;
        }

        if (!current || !line || line.startsWith("#")) continue;

        const qualityMatch = current.name.match(/\b(4K|UHD|FHD|HD|SD)\b/i);
        let quality = qualityMatch ? qualityMatch[1].toUpperCase() : "SD";
        if (quality === "UHD") quality = "4K";

        const baseName = current.name
            .replace(/\b(4K|UHD|FHD|HD|SD)\b/gi, "")
            .replace(/\s+/g, " ")
            .trim();

        const key = normalize(current.tvgId || baseName);

        if (!channels.has(key)) {
            channels.set(key, {
                id: "iptv_" + crypto.createHash("md5").update(key).digest("hex").slice(0, 12),
                name: baseName,
                streams: []
            });
        }

        channels.get(key).streams.push({
            url: line,
            title: `${baseName} (${quality})`,
            quality
        });

        current = null;
    }

    return Array.from(channels.values());
}

/* =========================
   DATA LOAD
========================= */
let CHANNELS = [];

async function loadM3U() {
    const m3uUrl = process.env.M3U_URL;

    if (!m3uUrl || !/^https?:\/\//i.test(m3uUrl)) {
        throw new Error("M3U_URL missing or not absolute");
    }

    const res = await fetch(m3uUrl);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);

    const text = await res.text();
    CHANNELS = parseM3U(text);
}

/* =========================
   CATALOG
========================= */
builder.defineCatalogHandler(() => {
    return {
        metas: CHANNELS.map(ch => ({
            id: ch.id,
            type: "tv",
            name: ch.name
        }))
    };
});

/* =========================
   STREAM
========================= */
builder.defineStreamHandler(({ id }) => {
    const ch = CHANNELS.find(c => c.id === id);
    if (!ch) return { streams: [] };

    return {
        streams: ch.streams.map(s => ({
            url: s.url,
            title: s.title,
            behaviorHints: { notWebReady: true }
        }))
    };
});

/* =========================
   INIT
========================= */
loadM3U().then(() => {
    console.log("M3U loaded:", CHANNELS.length, "channels");
}).catch(console.error);

module.exports = builder.getInterface();
