// xtream-config.js
// Content-type aware version (Live / Movies / Series)
// Checkbox selections actually control API fetches and manifest config

(function () {
    const form = document.getElementById('xtreamForm');
    if (!form) return;

    const $ = id => document.getElementById(id);

    const xtreamUrlInput = $('xtreamUrl');
    const userInput = $('xtreamUsername');
    const pwdInput = $('xtreamPassword');
    const togglePwdBtn = $('togglePwd');

    const includeLiveChk = $('includeLive');
    const includeMoviesChk = $('includeMovies');
    const includeSeriesChk = $('includeSeries');

    const enableEpgChk = $('enableEpg');
    const epgOffsetInput = $('epgOffsetHours');
    const debugChk = $('debugMode');
    const customEpgGroup = $('customEpgGroup');
    const customEpgUrlInp = $('customEpgUrl');

    const epgModeRadios = () =>
        [...document.querySelectorAll('input[name="epgMode"]')];

    const {
        showOverlay,
        hideOverlay,
        startPolling,
        buildUrls,
        appendDetail,
        setProgress,
        overlaySetMessage,
        forceDisableActions,
        prefillIfReconfigure
    } = window.ConfigureCommon || {};

    if (!window.ConfigureCommon) return;

    prefillIfReconfigure?.('xtream');

    function selectedEpgMode() {
        return epgModeRadios().find(r => r.checked)?.value || 'xtream';
    }

    function syncCustomEpgVisibility() {
        const show =
            enableEpgChk.checked && selectedEpgMode() === 'custom';
        customEpgGroup.classList.toggle('hidden', !show);
    }

    togglePwdBtn?.addEventListener('click', e => {
        e.preventDefault();
        pwdInput.type =
            pwdInput.type === 'password' ? 'text' : 'password';
        togglePwdBtn.textContent =
            pwdInput.type === 'password' ? 'Show' : 'Hide';
    });

    enableEpgChk.addEventListener('change', syncCustomEpgVisibility);
    epgModeRadios().forEach(r =>
        r.addEventListener('change', syncCustomEpgVisibility)
    );
    syncCustomEpgVisibility();

    function validateUrl(u) {
        try {
            const p = new URL(u);
            return p.protocol === 'http:' || p.protocol === 'https:';
        } catch {
            return false;
        }
    }

    function normalizedBaseUrl(u) {
        return u.trim().replace(/\/+$/, '');
    }

    async function fetchBrowser(url, label) {
        appendDetail(`→ (Browser) Fetching ${label}: ${url}`);
        const r = await fetch(url);
        if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
        const t = await r.text();
        appendDetail(`✔ (Browser) ${label} ${t.length.toLocaleString()} bytes`);
        return t;
    }

    async function fetchServer(url, label) {
        appendDetail(`→ (Server) Prefetch ${label}: ${url}`);
        const r = await fetch('/api/prefetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, purpose: label })
        });
        const j = await r.json();
        if (!r.ok || !j.ok) {
            throw new Error(j?.error || 'Server prefetch failed');
        }
        appendDetail(
            `✔ (Server) ${label} ${j.bytes.toLocaleString()} bytes` +
            (j.truncated ? ' (truncated)' : '')
        );
        if (j.truncated) {
            throw new Error('Prefetch truncated');
        }
        return j.content;
    }

    async function robustFetch(url, label) {
        try {
            return await fetchBrowser(url, label);
        } catch {
            appendDetail(`⚠ Browser fetch failed → server fallback`);
            return await fetchServer(url, label);
        }
    }

    function uuid() {
        return crypto.randomUUID
            ? crypto.randomUUID()
            : 'id-' + Math.random().toString(36).slice(2);
    }

    form.addEventListener('submit', async e => {
        e.preventDefault();

        const baseUrl = normalizedBaseUrl(xtreamUrlInput.value);
        const username = userInput.value.trim();
        let password = pwdInput.value;

        const includeLive = includeLiveChk.checked;
        const includeMovies = includeMoviesChk.checked;
        const includeSeries = includeSeriesChk.checked;

        if (!includeLive && !includeMovies && !includeSeries) {
            alert('Select at least one content type.');
            return;
        }

        if (!validateUrl(baseUrl) || !username || !password) {
            alert('Invalid Xtream credentials');
            return;
        }

        showOverlay(true);
        forceDisableActions?.();

        appendDetail('== PRE-FLIGHT (XTREAM) ==');
        appendDetail(`Base URL: ${baseUrl}`);
        appendDetail(`Content: Live=${includeLive}, Movies=${includeMovies}, Series=${includeSeries}`);

        const base =
            `${baseUrl}/player_api.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

        let liveCount = 0;
        let vodCount = 0;
        let seriesCount = 0;

        try {
            /* LIVE */
            if (includeLive) {
                setProgress(15, 'Fetching Live Streams');
                const txt = await robustFetch(
                    `${base}&action=get_live_streams`,
                    'live_streams'
                );
                const arr = JSON.parse(txt);
                liveCount = Array.isArray(arr) ? arr.length : 0;
                appendDetail(`✔ Live streams: ${liveCount.toLocaleString()}`);
            } else {
                appendDetail('⏭ Live streams skipped');
            }

/* MOVIES (VOD) – categories only */
if (includeMovies) {
    setProgress(30, 'Fetching VOD categories');
    const txt = await robustFetch(
        `${base}&action=get_vod_categories`,
        'vod_categories'
    );
    const categories = JSON.parse(txt);
    vodCount = Array.isArray(categories) ? categories.length : 0;
    appendDetail(`✔ VOD categories: ${vodCount.toLocaleString()}`);
} else {
    appendDetail('⏭ Movies skipped');
}


            /* SERIES (categories only – lightweight) */
            if (includeSeries) {
                setProgress(45, 'Fetching Series Categories');
                const txt = await robustFetch(
                    `${base}&action=get_series_categories`,
                    'series_categories'
                );
                const arr = JSON.parse(txt);
                seriesCount = Array.isArray(arr) ? arr.length : 0;
                appendDetail(`✔ Series categories: ${seriesCount.toLocaleString()}`);
            } else {
                appendDetail('⏭ Series skipped');
            }

            /* CONFIG BUILD */
            setProgress(60, 'Building config');

            const config = {
                provider: 'xtream',
                xtreamUrl: baseUrl,
                xtreamUsername: username,
                xtreamPassword: password,
                content: {
                    live: includeLive,
                    movies: includeMovies,
                    series: includeSeries
                },
                prescan: {
                    liveCount,
                    vodCount,
                    seriesCount
                },
                instanceId: uuid(),
                debug: debugChk.checked || undefined
            };

            const { manifestUrl, stremioUrl } = buildUrls(config);

            appendDetail('✔ Config built');
            appendDetail('Manifest URL: ' + manifestUrl);
            appendDetail('Stremio URL: ' + stremioUrl);

            setProgress(75, 'Waiting for manifest');
            startPolling(75);

        } catch (err) {
            overlaySetMessage('Failed');
            appendDetail('✖ Error: ' + err.message);
            setProgress(100, 'Error');
        }
    });
})();
