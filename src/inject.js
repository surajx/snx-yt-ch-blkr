// Runs in YouTube's own JavaScript context, before any of YouTube's code.
//
// Two jobs:
//   1. Gate: every player response (the data that tells the player what to play) is checked
//      against the allowlist. A video from another channel is made unplayable before it loads.
//   2. Prune: feed data (recommendations, search, end screen, channel pages) has entries from
//      other channels removed before YouTube renders it.
// A watchdog re-checks whatever the player is actually playing, in case a response reached the
// player by a route this script does not intercept.
//
// The first half of this file is pure logic and is also loaded by the Node tests.

(() => {
  'use strict';

  const UC_RE = /^UC[\w-]{22}$/;

  // Renderer names that stand for one playable thing in a feed.
  const ITEM_KEY_RE =
    /(?:video|movie|playlist|radio|show|station|reelItem|autoplay|lockup|channelVideoPlayer)(?:WithContext)?(?:Renderer|ViewModel)$/i;
  // Containers that should disappear once everything inside them has been removed.
  const SHELF_KEY_RE = /shelf|itemSection|richSection|cardList|carousel/i;
  // Thin wrappers: if the item under one of these keys goes, the wrapper goes with it.
  const BUBBLE_KEYS = new Set(['content', 'primaryRenderer']);
  const SKIP_KEYS = new Set(['responseContext', 'playerResponse', 'frameworkUpdates', 'topbar']);
  const CHANNEL_PATH_RE = /^\/(?:@|channel\/|c\/|user\/)/;
  const EXEMPT_PATHS = new Set(['/feed/subscriptions', '/feed/channels']);
  const API_RE = /\/youtubei\/v1\/([a-z_/]+)/i;
  const NOISE_RE =
    /^(?:log_event|att\/|player\/heartbeat|notification\/|feedback|account\/|live_chat\/|updated_metadata|comment\/|like\/|flag\/|ypc\/)/;

  function endpointOf(url) {
    const m = API_RE.exec(url || '');
    return m ? m[1] : '';
  }

  function shouldInspect(url) {
    const endpoint = endpointOf(url);
    return !!endpoint && !NOISE_RE.test(endpoint);
  }

  function collectChannelIds(node, out = new Set()) {
    const stack = [node];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (Array.isArray(cur)) {
        for (const x of cur) if (x && typeof x === 'object') stack.push(x);
        continue;
      }
      for (const key in cur) {
        const value = cur[key];
        if (typeof value === 'string') {
          if ((key === 'browseId' || key === 'channelId') && UC_RE.test(value)) out.add(value);
        } else if (value && typeof value === 'object') {
          stack.push(value);
        }
      }
    }
    return out;
  }

  function isItem(key, renderer) {
    if (!ITEM_KEY_RE.test(key)) return false;
    // A lockup that points at a channel is a channel result, not a video.
    if (typeof renderer.contentId === 'string' && UC_RE.test(renderer.contentId)) return false;
    if (typeof renderer.contentType === 'string' && renderer.contentType.includes('CHANNEL')) return false;
    return (
      typeof renderer.videoId === 'string' ||
      typeof renderer.playlistId === 'string' ||
      typeof renderer.contentId === 'string' ||
      typeof renderer.entityId === 'string'
    );
  }

  function isContinuationItem(el) {
    return !!el && typeof el === 'object' && 'continuationItemRenderer' in el;
  }

  // Removes disallowed items from `root` in place. Returns how many were removed.
  function pruneTree(root, { isAllowed, ctxChannel, isContinuation }) {
    let removed = 0;
    const keptVideoIds = new Set();
    const autoplaySets = [];
    // Items with no channel of their own (a channel page's video grid) inherit the page's channel.
    const ctxAllowed = !!ctxChannel && isAllowed(ctxChannel);

    function judge(renderer) {
      const ids = collectChannelIds(renderer);
      if (ids.size === 0) return ctxAllowed;
      for (const id of ids) if (isAllowed(id)) return true;
      return false;
    }

    // Returns true when removals left the array empty.
    function walkArray(arr) {
      let removedHere = 0;
      for (let i = arr.length - 1; i >= 0; i--) {
        const el = arr[i];
        if (!el || typeof el !== 'object') continue;
        if (Array.isArray(el)) {
          walkArray(el);
          continue;
        }
        const result = walkObject(el);
        let drop = result.rejected;
        if (!drop && result.emptied) {
          const keys = Object.keys(el);
          drop = keys.length === 1 && SHELF_KEY_RE.test(keys[0]);
        }
        if (drop) {
          arr.splice(i, 1);
          removedHere++;
        }
      }
      // A "load more" page that kept nothing: drop its continuation too, or YouTube keeps paging
      // through results that will all be removed.
      if (removedHere && isContinuation && arr.length && arr.every(isContinuationItem)) arr.length = 0;
      return removedHere > 0 && arr.length === 0;
    }

    function walkObject(obj) {
      let rejected = false;
      let emptied = false;
      for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (!value || typeof value !== 'object' || SKIP_KEYS.has(key)) continue;
        if (Array.isArray(value)) {
          if (key === 'sets') autoplaySets.push(value);
          if (walkArray(value)) emptied = true;
          continue;
        }
        if (isItem(key, value)) {
          if (judge(value)) {
            const id = value.videoId || value.contentId;
            if (typeof id === 'string') keptVideoIds.add(id);
          } else {
            delete obj[key];
            removed++;
            if (Object.keys(obj).length === 0) rejected = true;
          }
          continue;
        }
        const result = walkObject(value);
        if (result.rejected) {
          delete obj[key];
          if (BUBBLE_KEYS.has(key) || Object.keys(obj).length === 0) rejected = true;
        } else if (result.emptied) {
          emptied = true;
        }
      }
      return { rejected, emptied };
    }

    if (Array.isArray(root)) walkArray(root);
    else walkObject(root);

    // Autoplay must not advance to a video that was just removed from the page.
    for (const sets of autoplaySets) {
      for (const set of sets) {
        const next = set && set.autoplayVideo && set.autoplayVideo.watchEndpoint;
        if (next && !keptVideoIds.has(next.videoId)) {
          delete set.autoplayVideo;
          removed++;
        }
      }
    }
    return removed;
  }

  function serviceParam(root, name) {
    const groups = root && root.responseContext && root.responseContext.serviceTrackingParams;
    if (!Array.isArray(groups)) return '';
    for (const group of groups) {
      for (const param of group.params || []) if (param.key === name) return param.value || '';
    }
    return '';
  }

  function isPlayerResponse(node) {
    return !!node && typeof node === 'object' && !!node.playabilityStatus && !!(node.videoDetails || node.streamingData);
  }

  // Player responses can be the whole reply or nested a few levels down (get_watch returns an array).
  function findPlayerResponses(node, depth = 0, out = []) {
    if (!node || typeof node !== 'object' || depth > 3) return out;
    if (Array.isArray(node)) {
      for (const x of node) findPlayerResponses(x, depth + 1, out);
      return out;
    }
    if (isPlayerResponse(node)) {
      out.push(node);
      return out;
    }
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') findPlayerResponses(value, depth + 1, out);
    }
    return out;
  }

  function blockPlayerResponse(pr, reason, subreason) {
    for (const key of [
      'streamingData', 'playerAds', 'adPlacements', 'adSlots', 'adBreakHeartbeatParams',
      'endscreen', 'cards', 'storyboards', 'captions', 'playbackTracking',
    ]) {
      delete pr[key];
    }
    pr.playabilityStatus = {
      status: 'UNPLAYABLE',
      reason,
      errorScreen: {
        playerErrorMessageRenderer: { reason: { simpleText: reason }, subreason: { simpleText: subreason } },
      },
    };
  }

  // Prunes one API reply (or page-load data). env: { isAllowed, endpoint, requestBrowseId, pathname, lastChannel }
  function pruneResponse(json, env) {
    const roots = Array.isArray(json) ? json : [json];
    let removed = 0;
    let channel = null;
    for (const root of roots) {
      if (!root || typeof root !== 'object' || Array.isArray(root) || isPlayerResponse(root)) continue;
      const browseId = serviceParam(root, 'browse_id') || env.requestBrowseId || '';
      const isContinuation =
        !root.contents &&
        !!(root.onResponseReceivedActions || root.onResponseReceivedEndpoints ||
           root.onResponseReceivedCommands || root.continuationContents);
      const pathMayApply = !browseId && (env.endpoint === 'initial' || (env.endpoint === 'browse' && isContinuation));

      // The subscriptions feed is, by definition, only subscribed channels. Leave it alone.
      if (browseId === 'FEchannels' || browseId.startsWith('FEsubscriptions')) continue;
      if (pathMayApply && EXEMPT_PATHS.has(env.pathname)) continue;

      let ctxChannel = null;
      const metaId = root.metadata && root.metadata.channelMetadataRenderer && root.metadata.channelMetadataRenderer.externalId;
      if (UC_RE.test(browseId)) ctxChannel = browseId;
      else if (UC_RE.test(metaId || '')) ctxChannel = metaId;
      else if (pathMayApply && CHANNEL_PATH_RE.test(env.pathname)) ctxChannel = env.lastChannel || null;
      if (ctxChannel) channel = ctxChannel;

      removed += pruneTree(root, { isAllowed: env.isAllowed, ctxChannel, isContinuation });
    }
    return { removed, channel };
  }

  // The subscriptions listed in the left-hand guide, as [{id, title, handle}].
  function collectGuideSubscriptions(json) {
    const out = new Map();
    const visit = (node, inSubs) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const x of node) visit(x, inSubs);
        return;
      }
      for (const key in node) {
        const value = node[key];
        if (!value || typeof value !== 'object') continue;
        if (inSubs && key === 'guideEntryRenderer') {
          const browse = value.navigationEndpoint && value.navigationEndpoint.browseEndpoint;
          if (browse && UC_RE.test(browse.browseId || '')) {
            const base = browse.canonicalBaseUrl;
            out.set(browse.browseId, {
              id: browse.browseId,
              title: (value.formattedTitle && value.formattedTitle.simpleText) || '',
              handle: typeof base === 'string' && base.startsWith('/@') ? base.slice(1) : '',
            });
          }
          continue;
        }
        visit(value, inSubs || key === 'guideSubscriptionsSectionRenderer');
      }
    };
    visit(json, false);
    return [...out.values()];
  }

  const core = {
    endpointOf, shouldInspect, collectChannelIds, isItem, pruneTree, pruneResponse,
    findPlayerResponses, blockPlayerResponse, collectGuideSubscriptions,
  };

  if (typeof window === 'undefined' || typeof document === 'undefined') {
    if (typeof module === 'object' && module.exports) module.exports = core;
    return;
  }

  // ------------------------------------------------------------------------------------------
  // Browser wiring
  // ------------------------------------------------------------------------------------------

  let inFrame = true;
  try {
    inFrame = window.top !== window;
  } catch {
    inFrame = true;
  }
  // Inside frames, only embedded players matter (not live chat and other helper frames).
  if (inFrame && !/^\/embed\//.test(location.pathname)) return;

  const MIRROR_KEY = 'subonly:state';
  const TO_PAGE = 'subonly:to-page';
  const FROM_PAGE = 'subonly:from-page';
  const BLOCK_REASON = 'Blocked by Subscribed Only';
  const BLOCK_SUBREASON = 'This video is not from a channel you subscribe to.';

  // Until the real settings arrive, assume "on, nothing allowed": unknown means blocked.
  const state = { ready: false, enabled: true, ids: new Set() };
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const whenReady = () => Promise.race([readyPromise, new Promise((r) => setTimeout(r, 3000))]);

  function applyState(next) {
    state.enabled = next.enabled !== false;
    state.ids = new Set(Array.isArray(next.ids) ? next.ids : []);
    if (!state.ready) {
      state.ready = true;
      resolveReady();
    }
    scheduleInspect();
  }

  // Settings are mirrored into the page's localStorage so they can be read synchronously here,
  // before YouTube's first data is parsed. (Not available inside third-party embeds.)
  try {
    const raw = localStorage.getItem(MIRROR_KEY);
    if (raw) applyState(JSON.parse(raw));
  } catch {}

  const isAllowed = (channelId) => !state.enabled || (!!channelId && state.ids.has(channelId));

  // ---- messaging with the content script ----
  let contentReady = false;
  const outbox = [];
  function report(message) {
    if (!contentReady) {
      if (outbox.length < 200) outbox.push(message);
      return;
    }
    document.dispatchEvent(new CustomEvent(FROM_PAGE, { detail: JSON.stringify(message) }));
  }
  document.addEventListener(TO_PAGE, (event) => {
    let message;
    try {
      message = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (!message || message.type !== 'state') return;
    applyState(message);
    if (!contentReady) {
      contentReady = true;
      for (const queued of outbox.splice(0)) report(queued);
    }
  });
  document.dispatchEvent(new CustomEvent(FROM_PAGE, { detail: JSON.stringify({ type: 'hello' }) }));

  // ---- gate ----
  function gate(pr) {
    const details = pr.videoDetails || {};
    const allowed = isAllowed(details.channelId);
    report({
      type: 'verdict',
      allowed,
      videoId: details.videoId || null,
      channelId: details.channelId || null,
      author: details.author || '',
    });
    if (allowed) return false;
    blockPlayerResponse(pr, BLOCK_REASON, BLOCK_SUBREASON);
    return true;
  }

  // ---- feed pruning ----
  let lastChannel = null;
  function prune(json, endpoint, requestBrowseId) {
    const result = pruneResponse(json, {
      isAllowed,
      endpoint,
      requestBrowseId,
      pathname: location.pathname,
      lastChannel,
    });
    if (result.channel) lastChannel = result.channel;
    return result.removed;
  }

  // ---- page-load data: window.ytInitialData / window.ytInitialPlayerResponse ----
  // Filtering is deferred to the first read, by which time the settings have usually arrived.
  function hookGlobal(name, process) {
    let value;
    let processed = false;
    try {
      const existing = window[name];
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get() {
          if (!processed && value && typeof value === 'object') {
            processed = true;
            try {
              process(value);
            } catch {}
          }
          return value;
        },
        set(next) {
          value = next;
          processed = false;
        },
      });
      if (existing !== undefined) window[name] = existing;
    } catch {}
  }

  hookGlobal('ytInitialData', (data) => {
    if (state.enabled) prune(data, 'initial', '');
  });
  hookGlobal('ytInitialPlayerResponse', (pr) => {
    if (state.enabled && (pr.videoDetails || pr.streamingData)) gate(pr);
  });

  // ---- API replies ----
  function handleApiReply(url, text, requestText) {
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    const endpoint = endpointOf(url);
    let request = null;
    if (requestText) {
      try {
        request = JSON.parse(requestText);
      } catch {}
    }

    // Keep the allowlist current from what YouTube itself loads (independent of the on/off switch).
    if (endpoint === 'guide') {
      const channels = collectGuideSubscriptions(json);
      if (channels.length) report({ type: 'guide-subs', channels });
    }
    if (endpoint === 'subscription/subscribe' || endpoint === 'subscription/unsubscribe') {
      const ids = ((request && request.channelIds) || []).filter((id) => UC_RE.test(id));
      if (ids.length) report({ type: 'sub-change', op: endpoint.endsWith('/subscribe') ? 'add' : 'remove', ids });
      return null;
    }

    if (!state.enabled) return null;
    let changed = false;
    for (const pr of findPlayerResponses(json)) if (gate(pr)) changed = true;
    const requestBrowseId = (request && typeof request.browseId === 'string' && request.browseId) || '';
    if (prune(json, endpoint, requestBrowseId) > 0) changed = true;
    return changed ? JSON.stringify(json) : null;
  }

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input && input.url) || '';
    } catch {}
    if (!shouldInspect(url)) return nativeFetch.apply(this, arguments);

    // The request body says which page is being asked for and which channel is being (un)subscribed.
    let requestText = null;
    if (/\/(?:browse|subscription\/)/.test(url)) {
      try {
        if (typeof Request !== 'undefined' && input instanceof Request) requestText = input.clone().text();
        else if (init && typeof init.body === 'string') requestText = Promise.resolve(init.body);
      } catch {}
    }

    return nativeFetch.apply(this, arguments).then(async (response) => {
      try {
        if (!response.ok || !(response.headers.get('content-type') || '').includes('json')) return response;
        const text = await response.clone().text();
        if (!state.ready) await whenReady();
        const body = requestText ? await requestText.catch(() => null) : null;
        const rewritten = handleApiReply(url, text, body);
        if (rewritten === null) return response;
        const headers = new Headers(response.headers);
        headers.delete('content-length');
        headers.delete('content-encoding');
        const replacement = new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
        try {
          Object.defineProperties(replacement, {
            url: { value: response.url },
            redirected: { value: response.redirected },
            type: { value: response.type },
          });
        } catch {}
        return replacement;
      } catch {
        return response;
      }
    });
  };

  // ---- watchdog: check what the player has actually loaded ----
  let inspectQueued = false;
  function scheduleInspect() {
    if (inspectQueued) return;
    inspectQueued = true;
    setTimeout(() => {
      inspectQueued = false;
      if (!state.ready) {
        whenReady().then(inspectPlayers);
        return;
      }
      inspectPlayers();
    }, 0);
  }

  function inspectPlayers() {
    if (!state.enabled) return;
    for (const player of document.querySelectorAll('.html5-video-player')) {
      const video = player.querySelector('video');
      let pr = null;
      try {
        pr = typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      } catch {}
      const details = pr && pr.videoDetails;
      const playing = !!video && !video.paused && !video.ended;
      if (!details) {
        // Something is playing and there is no way to tell what it is: stop it.
        if (playing) halt(player, video, {});
        continue;
      }
      if (pr.playabilityStatus && pr.playabilityStatus.status !== 'OK') continue;
      if (!isAllowed(details.channelId)) halt(player, video, details);
    }
  }

  function halt(player, video, details) {
    try {
      if (typeof player.stopVideo === 'function') player.stopVideo();
    } catch {}
    try {
      if (video) video.pause();
    } catch {}
    report({
      type: 'verdict',
      allowed: false,
      videoId: details.videoId || null,
      channelId: details.channelId || null,
      author: details.author || '',
      source: 'watchdog',
    });
  }

  for (const name of ['play', 'playing', 'loadedmetadata']) {
    document.addEventListener(name, scheduleInspect, true);
  }
  for (const name of ['yt-navigate-finish', 'yt-player-updated', 'yt-page-data-updated']) {
    document.addEventListener(name, scheduleInspect);
  }
})();
