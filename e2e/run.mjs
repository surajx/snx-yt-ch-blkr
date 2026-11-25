// End-to-end check of the unpacked extension against live YouTube, in a throwaway browser profile.
// Run: node e2e/run.mjs            (all checks, headless, signed out)
//      ONLY=blocked,embed node e2e/run.mjs   HEADED=1 to watch   SHOTS_DIR=/some/dir for screenshots
// Uses no dependencies: it drives the browser over the DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = process.env.EXT_DIR || resolve(HERE, '..');
const SHOTS = process.env.SHOTS_DIR || '';
const BIN = process.env.BROWSER_BIN || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const PORT = Number(process.env.CDP_PORT || 9337);
const HEADLESS = process.env.HEADED ? [] : ['--headless=new'];
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);

const RICK = 'UCuAXFkgsw1L7xaCfnd5JJOw'; // Rick Astley
const ALLOWED_VIDEO = 'dQw4w9WgXcQ';
const BLOCKED_VIDEO = 'jNQXAC9IVRw'; // "Me at the zoo", channel jawed
const PLACEHOLDER = 'UCzzzzzzzzzzzzzzzzzzzzzz';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, pass, detail) => {
  results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + JSON.stringify(detail) : ''}`);
};

const profile = mkdtempSync(join(tmpdir(), 'subonly-e2e-'));
const browser = spawn(BIN, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${PORT}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--disable-features=DisableLoadExtensionCommandLineSwitch',
  '--no-first-run', '--no-default-browser-check', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--window-size=1400,900',
  ...HEADLESS, 'about:blank',
], { stdio: 'ignore' });

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(`<!doctype html><title>embed test</title>
    <iframe id="a" width="560" height="315" src="https://www.youtube.com/embed/${ALLOWED_VIDEO}" allow="autoplay"></iframe>
    <iframe id="b" width="560" height="315" src="https://www.youtube-nocookie.com/embed/${BLOCKED_VIDEO}" allow="autoplay"></iframe>`);
}).listen(8765);

let ws;
let nextId = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
      ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve);
        ws.addEventListener('error', reject);
      });
      ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        const p = msg.id && pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
      });
      return info;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('browser did not start');
}

const targets = async () => (await send('Target.getTargets')).targetInfos;
const attach = async (targetId) => (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId;

async function evaluate(sessionId, expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function waitFor(sessionId, expression, timeout = 25000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      last = await evaluate(sessionId, expression);
      if (last) return last;
    } catch (e) {
      last = String(e.message).slice(0, 120);
    }
    await sleep(500);
  }
  return null;
}
async function navigate(sessionId, url) {
  await send('Page.navigate', { url }, sessionId);
  await sleep(1500);
}
async function screenshot(sessionId, name) {
  if (!SHOTS) return;
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  writeFileSync(join(SHOTS, name), Buffer.from(data, 'base64'));
}

const PLAYER_STATE = `(() => {
  const p = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
  let pr = null; try { pr = p && p.getPlayerResponse && p.getPlayerResponse(); } catch (e) {}
  const v = document.querySelector('video');
  const host = document.getElementById('subonly-overlay-host');
  return JSON.stringify({
    path: location.pathname + location.search,
    status: pr && pr.playabilityStatus ? pr.playabilityStatus.status : null,
    reason: pr && pr.playabilityStatus ? pr.playabilityStatus.reason || null : null,
    channel: pr && pr.videoDetails ? pr.videoDetails.channelId : null,
    hasStreams: !!(pr && pr.streamingData),
    playing: !!v && !v.paused && v.currentTime > 0,
    overlay: !!host, overlayChannel: host ? host.dataset.channel : null,
  });
})()`;
const state = async (s) => JSON.parse(await evaluate(s, PLAYER_STATE));
const want = (name) => !ONLY.length || ONLY.includes(name);

try {
  const info = await connect();
  console.log('browser:', info.Browser, '| UA headless:', /Headless/.test(info['User-Agent']));

  // Find the extension.
  let extId = null;
  for (let i = 0; i < 40 && !extId; i++) {
    const sw = (await targets()).find((t) => t.url.startsWith('chrome-extension://') && t.url.endsWith('/src/background.js'));
    if (sw) extId = new URL(sw.url).host;
    else await sleep(500);
  }
  if (!extId) throw new Error('extension did not load (no service worker target)');
  console.log('extension id:', extId);

  const { targetId: optId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/src/options.html` });
  const opt = await attach(optId);
  await sleep(800);
  const setStore = (obj) => evaluate(opt, `chrome.storage.local.set(${JSON.stringify(obj)}).then(() => true)`);
  const getStore = (keys) => evaluate(opt, `chrome.storage.local.get(${JSON.stringify(keys)}).then((v) => JSON.stringify(v))`).then(JSON.parse);
  // attemptAt keeps the automatic sync quiet during the tests.
  await setStore({ enabled: true, subs: {}, extras: { [RICK]: { title: 'Rick Astley', handle: '@RickAstleyYT' } }, sync: { attemptAt: Date.now(), ok: false, error: 'test' } });

  const { targetId: pageId } = await send('Target.createTarget', { url: 'about:blank' });
  const page = await attach(pageId);
  await send('Page.enable', {}, page);

  if (want('allowed')) {
    await navigate(page, `https://www.youtube.com/watch?v=${ALLOWED_VIDEO}`);
    await waitFor(page, `(() => { const p = document.querySelector('#movie_player'); try { return !!(p && p.getPlayerResponse && p.getPlayerResponse()); } catch (e) { return false; } })()`);
    await sleep(4000);
    const s = await state(page);
    record('allowed video plays (hard load)', s.status === 'OK' && s.channel === RICK && !s.overlay && s.hasStreams, s);
    const side = JSON.parse(await evaluate(page, `(() => {
      const UC = /^UC[\\w-]{22}$/;
      const ids = (o, acc = new Set()) => { if (!o || typeof o !== 'object') return acc; for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string') { if ((k === 'browseId' || k === 'channelId') && UC.test(v)) acc.add(v); } else ids(v, acc); } return acc; };
      const sec = window.ytInitialData?.contents?.twoColumnWatchNextResults?.secondaryResults?.secondaryResults?.results || [];
      const items = sec.flatMap((s) => (s.itemSectionRenderer ? s.itemSectionRenderer.contents : [s]));
      const end = window.ytInitialData?.playerOverlays?.playerOverlayRenderer?.endScreen?.watchNextEndScreenRenderer?.results || [];
      return JSON.stringify({
        kinds: items.map((x) => Object.keys(x)[0]),
        channels: [...new Set(items.filter((x) => x.lockupViewModel).flatMap((x) => [...ids(x)]))],
        endChannels: [...new Set(end.flatMap((x) => [...ids(x)]))], endCount: end.length,
        domLockups: document.querySelectorAll('#secondary yt-lockup-view-model').length,
        domShorts: document.querySelectorAll('#secondary ytm-shorts-lockup-view-model, #secondary ytd-reel-shelf-renderer').length,
      });
    })()`));
    const onlyRick = (list) => list.every((id) => id === RICK);
    record('sidebar data holds only allowed channels', onlyRick(side.channels) && !side.kinds.includes('reelShelfRenderer'), side);
    record('end screen data holds only allowed channels', onlyRick(side.endChannels), { endCount: side.endCount });
    await sleep(3000);
    const dom = JSON.parse(await evaluate(page, `JSON.stringify({
      lockups: document.querySelectorAll('#secondary yt-lockup-view-model').length,
      shorts: document.querySelectorAll('#secondary ytm-shorts-lockup-view-model').length,
      names: [...document.querySelectorAll('#secondary yt-lockup-view-model')].slice(0, 30).map((e) => (e.innerText || '').split('\\n').slice(0, 2).join(' | ')),
    })`));
    record('rendered sidebar shows no Shorts shelf', dom.shorts === 0, dom);
    await screenshot(page, 'shot-allowed.png');
  }

  if (want('blocked')) {
    await navigate(page, `https://www.youtube.com/watch?v=${BLOCKED_VIDEO}`);
    await waitFor(page, `!!document.getElementById('subonly-overlay-host')`, 20000);
    await sleep(2500);
    const s = await state(page);
    record('other-channel video is blocked (hard load)', s.overlay && s.status === 'UNPLAYABLE' && !s.hasStreams && !s.playing && s.overlayChannel && s.overlayChannel !== RICK, s);
    await screenshot(page, 'shot-blocked.png');
  }

  if (want('search')) {
    await navigate(page, 'https://www.youtube.com/results?search_query=rick+astley');
    await waitFor(page, `document.querySelectorAll('ytd-search yt-lockup-view-model, ytd-search ytd-video-renderer').length > 0`, 20000);
    await sleep(2500);
    const r = JSON.parse(await evaluate(page, `(() => {
      const UC = /^UC[\\w-]{22}$/;
      const ids = (o, acc = new Set()) => { if (!o || typeof o !== 'object') return acc; for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string') { if ((k === 'browseId' || k === 'channelId') && UC.test(v)) acc.add(v); } else ids(v, acc); } return acc; };
      const secs = window.ytInitialData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
      const items = secs.flatMap((s) => (s.itemSectionRenderer ? s.itemSectionRenderer.contents : []));
      return JSON.stringify({
        kinds: items.map((x) => Object.keys(x)[0]),
        videoChannels: items.filter((x) => x.lockupViewModel || x.videoRenderer).map((x) => [...ids(x)]),
        domVideos: document.querySelectorAll('ytd-search yt-lockup-view-model').length,
        domShorts: document.querySelectorAll('ytd-search ytm-shorts-lockup-view-model').length,
      });
    })()`));
    const ok = r.videoChannels.length > 0 && r.videoChannels.every((list) => list.includes(RICK)) && !r.kinds.includes('gridShelfViewModel') && r.domShorts === 0;
    record('search shows only allowed-channel videos, no Shorts shelves', ok, { kinds: r.kinds, domVideos: r.domVideos, domShorts: r.domShorts });
    await screenshot(page, 'shot-search.png');

    // In-page navigation to an allowed video.
    const clicked = await evaluate(page, `(() => { const a = document.querySelector('ytd-search yt-lockup-view-model a[href*="/watch?v="]'); if (!a) return null; a.click(); return a.getAttribute('href'); })()`);
    await waitFor(page, `location.pathname === '/watch'`, 15000);
    await sleep(5000);
    const s = await state(page);
    record('allowed video plays (in-page navigation)', !!clicked && s.status === 'OK' && s.channel === RICK && !s.overlay, { clicked, ...s });

    // Take the channel off the list, then click through to another of its videos without reloading.
    await setStore({ extras: { [PLACEHOLDER]: { title: 'placeholder', handle: '' } } });
    await sleep(1500);
    const before = await evaluate(page, 'location.href');
    const clicked2 = await evaluate(page, `(() => { const cur = new URLSearchParams(location.search).get('v'); const a = [...document.querySelectorAll('#secondary yt-lockup-view-model a[href*="/watch?v="]')].find((x) => !x.href.includes(cur)); if (!a) return null; a.click(); return a.getAttribute('href'); })()`);
    await waitFor(page, `location.href !== ${JSON.stringify(before)}`, 15000);
    await waitFor(page, `!!document.getElementById('subonly-overlay-host')`, 15000);
    await sleep(2000);
    const s2 = await state(page);
    record('now-disallowed video is blocked (in-page navigation)', !!clicked2 && s2.overlay && !s2.playing && s2.status !== 'OK', { clicked2, ...s2 });
    await setStore({ extras: { [RICK]: { title: 'Rick Astley', handle: '@RickAstleyYT' } } });
    await sleep(2500);
  }

  if (want('home')) {
    await navigate(page, 'https://www.youtube.com/');
    const ok = await waitFor(page, `location.pathname === '/feed/subscriptions'`, 15000);
    record('home redirects to the subscriptions feed', !!ok, { path: await evaluate(page, 'location.pathname') });
  }

  if (want('channel')) {
    await navigate(page, 'https://www.youtube.com/@RickAstleyYT/videos');
    await waitFor(page, `document.querySelectorAll('ytd-rich-item-renderer').length > 0`, 20000);
    const mine = await evaluate(page, `document.querySelectorAll('ytd-rich-item-renderer').length`);
    record('allowed channel page still lists its videos', mine > 0, { items: mine });
    await navigate(page, 'https://www.youtube.com/@jawed/videos');
    await sleep(6000);
    const theirs = await evaluate(page, `JSON.stringify({ items: document.querySelectorAll('ytd-rich-item-renderer').length, header: !!document.querySelector('yt-page-header-renderer, ytd-c4-tabbed-header-renderer, #page-header') })`);
    record('other channel page loads with its videos removed', JSON.parse(theirs).items === 0, JSON.parse(theirs));
    await screenshot(page, 'shot-channel-other.png');
  }

  if (want('toggle')) {
    await navigate(page, `https://www.youtube.com/watch?v=${BLOCKED_VIDEO}`);
    await waitFor(page, `!!document.getElementById('subonly-overlay-host')`, 20000);
    await setStore({ enabled: false });
    await sleep(2000);
    await waitFor(page, `(() => { const p = document.querySelector('#movie_player'); try { return p.getPlayerResponse().playabilityStatus.status === 'OK'; } catch (e) { return false; } })()`, 20000);
    const off = await state(page);
    record('turning it off reloads the tab and the video is playable', off.status === 'OK' && !off.overlay, off);
    await navigate(page, 'https://www.youtube.com/');
    await sleep(3000);
    record('off: home is not redirected', (await evaluate(page, 'location.pathname')) === '/', {});
    await navigate(page, `https://www.youtube.com/watch?v=${BLOCKED_VIDEO}`);
    await sleep(4000);
    await setStore({ enabled: true });
    const back = await waitFor(page, `!!document.getElementById('subonly-overlay-host')`, 20000);
    await sleep(1500);
    const on = await state(page);
    record('turning it back on reloads the tab and blocks again', !!back && on.status === 'UNPLAYABLE' && !on.playing, on);
  }

  if (want('embed')) {
    await navigate(page, 'http://localhost:8765/');
    await sleep(6000);
    const frames = (await targets()).filter((t) => t.type === 'iframe' && /\/embed\//.test(t.url));
    console.log('embed frames:', frames.map((f) => f.url));
    for (const [video, expectAllowed] of [[ALLOWED_VIDEO, true], [BLOCKED_VIDEO, false]]) {
      const frame = frames.find((f) => f.url.includes(video));
      if (!frame) {
        record(`embed ${expectAllowed ? 'allowed' : 'blocked'}: frame found`, false, {});
        continue;
      }
      const fs = await attach(frame.targetId);
      await evaluate(fs, `(() => { const p = document.querySelector('.html5-video-player'); try { p.playVideo(); } catch (e) {} const b = document.querySelector('.ytp-large-play-button'); if (b) b.click(); return true; })()`);
      await sleep(7000);
      const s = await state(fs);
      if (expectAllowed) record('embed of an allowed channel plays', s.status === 'OK' && !s.overlay, s);
      else record('embed of another channel is blocked', !s.playing && (s.overlay || s.status === 'UNPLAYABLE'), s);
    }
    await screenshot(page, 'shot-embed.png');
  }

  if (want('shorts')) {
    await navigate(page, 'https://www.youtube.com/shorts/-Rdhra2LM_k');
    const shown = await waitFor(page, `!!document.getElementById('subonly-overlay-host')`, 20000);
    await sleep(2500);
    const s = await state(page);
    record('a Short from another channel is blocked', !!shown && s.overlay && !s.playing, s);
    await screenshot(page, 'shot-shorts.png');
  }

  if (want('options')) {
    const JAWED = 'UC4QobU6STFB0P71PMvOGN5A';
    await evaluate(opt, `(() => { document.getElementById('addInput').value = '@jawed'; document.getElementById('addForm').requestSubmit(); return true; })()`);
    const added = await waitFor(opt, `chrome.storage.local.get('extras').then((v) => (v.extras['${JAWED}'] ? JSON.stringify(v.extras['${JAWED}']) : ''))`, 20000);
    await sleep(500);
    await screenshot(opt, 'shot-options.png');
    record('options page resolves an @handle and adds the channel', !!added, { added, status: await evaluate(opt, `document.getElementById('addStatus').textContent`) });
    await evaluate(opt, `(() => { const li = [...document.querySelectorAll('#extras li')].find((x) => /jawed/i.test(x.textContent)); if (li) li.querySelector('button').click(); return !!li; })()`);
    const gone = await waitFor(opt, `chrome.storage.local.get('extras').then((v) => !v.extras['${JAWED}'])`, 8000);
    record('options page removes a hand-added channel', !!gone, {});
    const { targetId: popId } = await send('Target.createTarget', { url: `chrome-extension://${extId}/src/popup.html` });
    const pop = await attach(popId);
    await sleep(1000);
    const text = await evaluate(pop, `JSON.stringify({ summary: document.getElementById('summary').textContent, sync: document.getElementById('syncStatus').textContent, problem: document.getElementById('problem').textContent, on: document.getElementById('enabled').checked })`);
    await screenshot(pop, 'shot-popup.png');
    record('popup renders status', /Only 1 channel can play/.test(JSON.parse(text).summary), JSON.parse(text));
  }

  if (want('sync')) {
    await navigate(page, 'https://www.youtube.com/feed/subscriptions');
    await sleep(3000);
    const sent = await evaluate(opt, `chrome.tabs.query({ url: 'https://www.youtube.com/*' }).then(async (tabs) => { for (const t of tabs) { try { const r = await chrome.tabs.sendMessage(t.id, { type: 'subonly-sync' }, { frameId: 0 }); if (r && r.started) return true; } catch (e) {} } return false; })`);
    await sleep(6000);
    const { sync, subs, extras } = await getStore(['sync', 'subs', 'extras']);
    record('signed-out sync fails cleanly and keeps the list', sent && sync.ok === false && /not-signed-in/.test(sync.error || '') && Object.keys(extras).length === 1, { sent, sync, subs: Object.keys(subs).length });
  }
} catch (error) {
  record('harness', false, { error: String(error && error.stack || error).slice(0, 600) });
} finally {
  try { ws && ws.close(); } catch {}
  browser.kill('SIGTERM');
  server.close();
  await sleep(1000);
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
