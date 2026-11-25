const $ = (id) => document.getElementById(id);

const ERRORS = {
  'not-signed-in': 'You are signed out of YouTube. Sign in, then sync again.',
  'not-signed-in-or-offline': 'Could not reach your subscriptions. Check that you are signed in to YouTube.',
  'parse-failed': "Could not read YouTube's subscriptions page. Its layout may have changed.",
  'no-channels-found': 'No subscribed channels were found on your account.',
};

function ago(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

async function render() {
  const st = await chrome.storage.local.get(['enabled', 'subs', 'extras', 'sync', 'syncLock']);
  const enabled = st.enabled !== false;
  const synced = Object.keys(st.subs || {}).length;
  const extra = Object.keys(st.extras || {}).length;
  const total = synced + extra;
  const sync = st.sync || {};
  const running = !!st.syncLock && Date.now() - st.syncLock < 60000;

  $('enabled').checked = enabled;
  if (!enabled) {
    $('summary').textContent = 'Off. YouTube is unfiltered.';
  } else if (total === 0) {
    $('summary').textContent = 'On, but no channels are allowed yet, so every video is blocked.';
  } else {
    const parts = `${synced} subscribed` + (extra ? ` + ${extra} added by hand` : '');
    $('summary').textContent = `On. Only ${total} channel${total === 1 ? '' : 's'} can play (${parts}).`;
  }

  if (running) $('syncStatus').textContent = 'Syncing subscriptions…';
  else if (sync.at) $('syncStatus').textContent = `Subscriptions synced ${ago(sync.at)}.`;
  else $('syncStatus').textContent = 'Subscriptions have not been synced yet.';

  let problem = '';
  if (sync.attemptAt && sync.ok === false) {
    problem = ERRORS[sync.error] || `Last sync failed (${sync.error}).`;
  } else if (sync.partial) {
    problem = 'The last sync could not read the whole list. Channels already known were kept.';
  }
  $('problem').textContent = problem;
  $('problem').hidden = !problem;
  $('sync').disabled = running;
}

$('enabled').addEventListener('change', (event) => {
  chrome.storage.local.set({ enabled: event.target.checked });
});

$('manage').addEventListener('click', () => chrome.runtime.openOptionsPage());

$('sync').addEventListener('click', async () => {
  $('sync').disabled = true;
  $('syncStatus').textContent = 'Syncing subscriptions…';
  // The sync runs inside a YouTube tab, where the request is same-origin. Use one if it is open.
  const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
  for (const tab of tabs) {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'subonly-sync' }, { frameId: 0 });
      if (reply && reply.started) return;
    } catch {
      // tab predates this version of the extension; try the next one
    }
  }
  // None available: leave a request and open one in the background to pick it up.
  await chrome.storage.local.set({ syncRequest: Date.now() });
  await chrome.tabs.create({ url: 'https://www.youtube.com/feed/channels', active: false });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') render();
});

render();
