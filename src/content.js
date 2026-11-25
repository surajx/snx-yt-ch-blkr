// Content script (isolated world). Bridges extension storage to the page-context script,
// draws the block screen, redirects algorithmic pages, and keeps the channel list in sync.

(() => {
  'use strict';

  let isTop = false;
  try {
    isTop = window.top === window;
  } catch {}
  const isEmbed = /^\/embed\//.test(location.pathname);
  if (!isTop && !isEmbed) return;
  const canSync = isTop && !isEmbed && location.hostname === 'www.youtube.com';

  const MIRROR_KEY = 'subonly:state';
  const RELOAD_KEY = 'subonly:reloaded';
  const TO_PAGE = 'subonly:to-page';
  const FROM_PAGE = 'subonly:from-page';
  const OVERLAY_ID = 'subonly-overlay-host';
  const REDIRECT_PATHS = new Set(['/', '/feed/trending', '/feed/explore']);
  const SUBSCRIPTIONS_URL = '/feed/subscriptions';
  const HOUR = 3600 * 1000;

  let current = null; // { enabled, ids: string[] }
  const verdicts = new Map(); // videoId -> { allowed, channelId, author }

  // ---- small helpers ----
  const lsGet = (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  };
  const lsSet = (key, value) => {
    try {
      localStorage.setItem(key, value);
      return localStorage.getItem(key) === value;
    } catch {
      return false;
    }
  };
  const toPage = (message) =>
    document.dispatchEvent(new CustomEvent(TO_PAGE, { detail: JSON.stringify(message) }));

  // Reload at most once per ten seconds, and only if that guard can actually be stored.
  function reloadOnce() {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
      if (Date.now() - last < 10000) return false;
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
      if (sessionStorage.getItem(RELOAD_KEY) === null) return false;
    } catch {
      return false;
    }
    location.reload();
    return true;
  }

  function videoIdFromLocation() {
    if (location.pathname === '/watch') return new URLSearchParams(location.search).get('v');
    const m = location.pathname.match(/^\/(?:shorts|live|embed|v)\/([\w-]{6,})/);
    return m ? m[1] : null;
  }

  // ---- settings ----
  async function loadPayload() {
    const st = await chrome.storage.local.get(['enabled', 'subs', 'extras']);
    const ids = new Set([...Object.keys(st.subs || {}), ...Object.keys(st.extras || {})]);
    return { enabled: st.enabled !== false, ids: [...ids].sort() };
  }

  async function refresh(initial) {
    let payload;
    try {
      payload = await loadPayload();
    } catch {
      return; // extension was reloaded or removed; this script is orphaned
    }
    const json = JSON.stringify(payload);
    const previous = current;
    current = payload;
    toPage({ type: 'state', ...payload });

    const mirrorBefore = lsGet(MIRROR_KEY);
    const mirrorStored = mirrorBefore === json || lsSet(MIRROR_KEY, json);

    if (initial) {
      // The page-context script started from the mirror (or, with none, from "on, nothing allowed").
      // If that differs from the real settings, the first data was filtered wrongly: start over.
      const assumed = mirrorBefore || JSON.stringify({ enabled: true, ids: [] });
      if (isTop && assumed !== json && mirrorStored && reloadOnce()) return;
    } else if (previous) {
      if (previous.enabled !== payload.enabled) {
        location.reload();
        return;
      }
      const firstList = previous.ids.length === 0 && payload.ids.length > 0;
      const blocked = overlayVerdict();
      const nowAllowed = blocked && blocked.channelId && payload.ids.includes(blocked.channelId);
      if ((firstList || nowAllowed) && reloadOnce()) return;
    }
    maybeRedirect();
    render();
  }

  // ---- redirects away from algorithmic pages ----
  function maybeRedirect(enabled = current && current.enabled) {
    if (!isTop || isEmbed || !enabled) return;
    if (REDIRECT_PATHS.has(location.pathname)) location.replace(SUBSCRIPTIONS_URL);
  }

  // ---- block screen ----
  let overlay = null;

  function buildOverlay() {
    const host = document.createElement('div');
    host.id = OVERLAY_ID;
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; position: fixed; left: 0; right: 0; bottom: 0; top: ${isEmbed ? '0' : '56px'};
              z-index: 2000; display: block; }
      .wrap { box-sizing: border-box; height: 100%; display: flex; flex-direction: column; align-items: center;
              justify-content: center; gap: 12px; padding: 24px; text-align: center;
              background: #0f0f0f; color: #f1f1f1;
              font: 16px/1.5 Roboto, system-ui, -apple-system, "Segoe UI", sans-serif; }
      h1 { margin: 0; font-size: ${isEmbed ? '18px' : '26px'}; font-weight: 600; line-height: 1.25; text-wrap: balance; }
      p { margin: 0; max-width: 46ch; color: #aaa; font-size: ${isEmbed ? '13px' : '15px'}; text-wrap: pretty; }
      .actions { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 12px; }
      a { color: #0f0f0f; background: #f1f1f1; text-decoration: none; font-size: 14px; font-weight: 500;
          padding: 9px 16px; border-radius: 18px; }
      a.secondary { color: #f1f1f1; background: #272727; }
      a:focus-visible { outline: 2px solid #3ea6ff; outline-offset: 2px; }
      .tag { margin-top: 18px; font-size: 12px; color: #717171; letter-spacing: 0.02em; }
    `;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.setAttribute('role', 'alert');
    const title = document.createElement('h1');
    const detail = document.createElement('p');
    const actions = document.createElement('div');
    actions.className = 'actions';
    const channelLink = document.createElement('a');
    channelLink.textContent = 'Open channel page';
    const subsLink = document.createElement('a');
    subsLink.className = 'secondary';
    subsLink.textContent = 'Go to Subscriptions';
    subsLink.href = 'https://www.youtube.com' + SUBSCRIPTIONS_URL;
    if (isEmbed) {
      channelLink.target = '_blank';
      channelLink.rel = 'noopener';
      subsLink.hidden = true;
    }
    actions.append(channelLink, subsLink);
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = 'Subscribed Only is on';
    wrap.append(title, detail, actions, tag);
    root.append(style, wrap);
    return { host, title, detail, channelLink };
  }

  function overlayVerdict() {
    if (!current || !current.enabled) return null;
    const id = videoIdFromLocation();
    const verdict = id ? verdicts.get(id) : null;
    return verdict && verdict.allowed === false ? verdict : null;
  }

  function render() {
    const verdict = overlayVerdict();
    if (!verdict) {
      if (overlay && overlay.host.isConnected) overlay.host.remove();
      return;
    }
    if (!overlay) overlay = buildOverlay();
    const name = verdict.author || 'This channel';
    if (current.ids.length === 0) {
      overlay.title.textContent = 'Your channel list is empty';
      overlay.detail.textContent =
        'Nothing can play until your subscriptions are synced. Sign in to YouTube, then press "Sync now" in the Subscribed Only popup.';
    } else if (!verdict.channelId) {
      overlay.title.textContent = "Couldn't verify this video's channel";
      overlay.detail.textContent = 'Videos are blocked unless they are confirmed to be from a channel you subscribe to.';
    } else {
      overlay.title.textContent = `${name} isn't one of your subscribed channels`;
      overlay.detail.textContent = 'This video is blocked. To watch it, subscribe to the channel or turn Subscribed Only off.';
    }
    overlay.channelLink.hidden = !verdict.channelId;
    if (verdict.channelId) overlay.channelLink.href = `https://www.youtube.com/channel/${verdict.channelId}`;
    overlay.host.dataset.video = videoIdFromLocation() || '';
    overlay.host.dataset.channel = verdict.channelId || '';
    if (!overlay.host.isConnected) (document.documentElement || document).append(overlay.host);
  }

  // ---- channel list maintenance ----
  async function mergeChannels(channels) {
    const { subs = {} } = await chrome.storage.local.get('subs');
    let changed = false;
    for (const ch of channels) {
      const old = subs[ch.id];
      const next = { title: ch.title || (old && old.title) || '', handle: ch.handle || (old && old.handle) || '' };
      if (!old || old.title !== next.title || old.handle !== next.handle) {
        subs[ch.id] = next;
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ subs });
  }

  async function removeChannels(ids) {
    const { subs = {} } = await chrome.storage.local.get('subs');
    let changed = false;
    for (const id of ids) {
      if (subs[id]) {
        delete subs[id];
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ subs });
  }

  let syncing = false;
  async function runSync() {
    if (!canSync || syncing) return;
    syncing = true;
    const startedAt = Date.now();
    try {
      await chrome.storage.local.set({ syncLock: startedAt });
      let result;
      try {
        result = await SubOnlySync.fetchSubscriptions(document.cookie);
      } catch (error) {
        result = { ok: false, error: String((error && error.message) || error) };
      }
      const { subs = {}, sync = {} } = await chrome.storage.local.get(['subs', 'sync']);
      const status = { ...sync, attemptAt: startedAt, ok: !!result.ok, error: result.ok ? null : result.error };
      const patch = {};
      if (result.ok) {
        const fresh = {};
        for (const ch of result.channels) fresh[ch.id] = { title: ch.title, handle: ch.handle };
        // A complete list replaces what was stored; an incomplete one is only added to it,
        // so a paging failure can never drop channels.
        patch.subs = result.partial ? { ...subs, ...fresh } : fresh;
        status.at = startedAt;
        status.partial = !!result.partial;
        status.count = Object.keys(patch.subs).length;
      }
      patch.sync = status;
      await chrome.storage.local.set(patch);
    } catch {
      // storage unavailable: the extension context is gone
    } finally {
      syncing = false;
      try {
        await chrome.storage.local.remove('syncLock');
      } catch {}
    }
  }

  async function maybeSync() {
    if (!canSync) return;
    let st;
    try {
      st = await chrome.storage.local.get(['sync', 'syncRequest', 'syncLock']);
    } catch {
      return;
    }
    const now = Date.now();
    const sync = st.sync || {};
    const lastAttempt = sync.attemptAt || 0;
    const signedIn = /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=/.test(document.cookie);
    let due;
    if ((st.syncRequest || 0) > lastAttempt) due = true; // "Sync now" pressed with no YouTube tab open
    else if (sync.ok) due = now - (sync.at || 0) > 12 * HOUR;
    else if (signedIn) due = now - lastAttempt > 60 * 1000; // failed while signed out, signed in since
    else due = now - lastAttempt > HOUR / 2;
    if (!due) return;
    if (st.syncLock && now - st.syncLock < 60 * 1000) return; // another tab is already syncing
    runSync();
  }

  // ---- wiring ----
  document.addEventListener(FROM_PAGE, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!message) return;
    if (message.type === 'hello') {
      if (current) toPage({ type: 'state', ...current });
    } else if (message.type === 'verdict') {
      const id = message.videoId || videoIdFromLocation();
      if (!id) return;
      verdicts.delete(id);
      verdicts.set(id, message);
      if (verdicts.size > 200) verdicts.delete(verdicts.keys().next().value);
      render();
    } else if (message.type === 'guide-subs') {
      mergeChannels(message.channels).catch(() => {});
    } else if (message.type === 'sub-change') {
      const work =
        message.op === 'add'
          ? mergeChannels(message.ids.map((id) => ({ id, title: '', handle: '' })))
          : removeChannels(message.ids);
      work.catch(() => {});
    }
  });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && (changes.enabled || changes.subs || changes.extras)) refresh(false);
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message && message.type === 'subonly-sync' && canSync) {
        runSync();
        sendResponse({ started: true });
      }
    });
  } catch {}

  // Redirect as early as possible when the mirrored settings already say "on".
  try {
    const mirror = JSON.parse(lsGet(MIRROR_KEY) || 'null');
    if (mirror && mirror.enabled) maybeRedirect(true);
  } catch {}

  let lastHref = location.href;
  const onNavigate = () => {
    lastHref = location.href;
    maybeRedirect();
    render();
  };
  for (const name of ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated']) {
    document.addEventListener(name, onNavigate);
  }
  window.addEventListener('popstate', onNavigate);
  // Some in-page navigations (swiping through Shorts) change the URL without a navigation event.
  setInterval(() => {
    if (location.href !== lastHref) onNavigate();
  }, 500);

  refresh(true).then(() => {
    if (canSync) setTimeout(maybeSync, 2500);
  });
})();
