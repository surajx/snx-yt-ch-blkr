// Reads the signed-in user's subscription list from YouTube's own "All subscriptions" page.
// Runs in the content script's isolated world on www.youtube.com, so requests are same-origin
// and carry the user's normal session. Also loaded by the Node tests (pure helpers only).

(() => {
  'use strict';

  const UC_RE = /^UC[\w-]{22}$/;
  const ORIGIN = 'https://www.youtube.com';
  const MAX_PAGES = 60;

  // Parses the JSON object literal that follows `marker` in `text`.
  function extractJsonAfter(text, marker) {
    const at = text.indexOf(marker);
    if (at < 0) return null;
    const start = text.indexOf('{', at + marker.length);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (c === 92) escaped = true;
        else if (c === 34) inString = false;
      } else if (c === 34) {
        inString = true;
      } else if (c === 123) {
        depth++;
      } else if (c === 125 && --depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  function textOf(t) {
    if (!t) return '';
    if (typeof t === 'string') return t;
    if (typeof t.simpleText === 'string') return t.simpleText;
    if (typeof t.content === 'string') return t.content;
    if (Array.isArray(t.runs)) return t.runs.map((r) => r.text || '').join('');
    return '';
  }

  function handleOf(renderer) {
    const base = renderer?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl;
    if (typeof base === 'string' && base.startsWith('/@')) return base.slice(1);
    const sub = textOf(renderer?.subscriberCountText);
    return sub.startsWith('@') ? sub : '';
  }

  // Every channelRenderer in the tree, as Map<channelId, {title, handle}>.
  function collectChannels(root, out = new Map()) {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Array.isArray(cur)) {
        for (const x of cur) stack.push(x);
        continue;
      }
      for (const key in cur) {
        const value = cur[key];
        if (!value || typeof value !== 'object') continue;
        if (key === 'channelRenderer' && UC_RE.test(value.channelId)) {
          out.set(value.channelId, { title: textOf(value.title), handle: handleOf(value) });
        } else {
          stack.push(value);
        }
      }
    }
    return out;
  }

  // Fallback for a layout this code does not know: any channel link in the main content area.
  function collectChannelIdsLoose(root, out = new Map()) {
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Array.isArray(cur)) {
        for (const x of cur) stack.push(x);
        continue;
      }
      for (const key in cur) {
        const value = cur[key];
        if (typeof value === 'string') {
          if (key === 'browseId' && UC_RE.test(value) && !out.has(value)) {
            const base = cur.canonicalBaseUrl;
            out.set(value, { title: '', handle: typeof base === 'string' && base.startsWith('/@') ? base.slice(1) : '' });
          }
        } else if (value && typeof value === 'object') {
          stack.push(value);
        }
      }
    }
    return out;
  }

  function findContinuationToken(node) {
    if (!node || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const x of node) {
        const token = findContinuationToken(x);
        if (token) return token;
      }
      return null;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (!value || typeof value !== 'object') continue;
      if (key === 'continuationItemRenderer') {
        const token = value.continuationEndpoint?.continuationCommand?.token;
        if (typeof token === 'string') return token;
        continue;
      }
      const token = findContinuationToken(value);
      if (token) return token;
    }
    return null;
  }

  function readPageConfig(html) {
    const pick = (re) => {
      const m = html.match(re);
      return m ? m[1] : null;
    };
    return {
      context: extractJsonAfter(html, '"INNERTUBE_CONTEXT":'),
      clientVersion: pick(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/),
      sessionIndex: pick(/"SESSION_INDEX":"?(\d+)"?/),
      pageId: pick(/"DELEGATED_SESSION_ID":"([^"]+)"/),
    };
  }

  async function sha1Hex(text) {
    const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // The same Authorization header YouTube's own page sends for signed-in API calls.
  async function authHeader(cookieString) {
    const cookie = (name) => {
      const m = cookieString.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
      return m ? m[1] : null;
    };
    const ts = Math.floor(Date.now() / 1000);
    const parts = [];
    const add = async (label, value) => {
      if (value) parts.push(`${label} ${ts}_${await sha1Hex(`${ts} ${value} ${ORIGIN}`)}`);
    };
    await add('SAPISIDHASH', cookie('SAPISID') || cookie('__Secure-3PAPISID'));
    await add('SAPISID1PHASH', cookie('__Secure-1PAPISID'));
    await add('SAPISID3PHASH', cookie('__Secure-3PAPISID'));
    return parts.join(' ');
  }

  async function fetchContinuation(token, config, cookieString) {
    if (!config.context) throw new Error('no-context');
    const headers = {
      'content-type': 'application/json',
      'x-origin': ORIGIN,
      'x-youtube-client-name': '1',
      'x-goog-authuser': config.sessionIndex || '0',
    };
    if (config.clientVersion) headers['x-youtube-client-version'] = config.clientVersion;
    if (config.pageId) headers['x-goog-pageid'] = config.pageId;
    const auth = await authHeader(cookieString);
    if (auth) headers.authorization = auth;
    const res = await fetch(`${ORIGIN}/youtubei/v1/browse?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context: config.context, continuation: token }),
    });
    if (!res.ok) throw new Error('http-' + res.status);
    return res.json();
  }

  // Resolves to { ok, channels: [{id, title, handle}], partial, error }.
  async function fetchSubscriptions(cookieString = '') {
    let html;
    try {
      const res = await fetch(`${ORIGIN}/feed/channels`, { credentials: 'include' });
      if (!res.ok) return { ok: false, error: 'http-' + res.status };
      html = await res.text();
    } catch {
      // A signed-out session redirects to Google's sign-in page, which the browser refuses to follow here.
      return { ok: false, error: 'not-signed-in-or-offline' };
    }
    if (!/"LOGGED_IN"\s*:\s*true/.test(html)) return { ok: false, error: 'not-signed-in' };

    const data = extractJsonAfter(html, 'var ytInitialData =') || extractJsonAfter(html, 'ytInitialData"] =');
    if (!data) return { ok: false, error: 'parse-failed' };

    const channels = collectChannels(data);
    let loose = false;
    if (channels.size === 0 && data.contents) {
      collectChannelIdsLoose(data.contents, channels);
      loose = true;
    }

    let partial = false;
    let token = findContinuationToken(data.contents || data);
    if (token) {
      const config = readPageConfig(html);
      for (let page = 0; token && page < MAX_PAGES; page++) {
        let json;
        try {
          json = await fetchContinuation(token, config, cookieString);
        } catch {
          partial = true;
          break;
        }
        const before = channels.size;
        if (loose) collectChannelIdsLoose(json, channels);
        else collectChannels(json, channels);
        token = findContinuationToken(json);
        if (channels.size === before) break; // nothing new: stop paging
      }
      if (token) partial = true;
    }

    if (channels.size === 0) return { ok: false, error: 'no-channels-found' };
    return {
      ok: true,
      partial,
      channels: [...channels].map(([id, info]) => ({ id, title: info.title, handle: info.handle })),
    };
  }

  const api = { extractJsonAfter, collectChannels, collectChannelIdsLoose, findContinuationToken, fetchSubscriptions };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.SubOnlySync = api;
})();
