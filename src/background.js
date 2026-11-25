// Service worker: first-run defaults and the toolbar badge.
// All filtering happens in the content scripts; nothing here is on the hot path.

const DEFAULTS = { enabled: true, subs: {}, extras: {} };

async function ensureDefaults() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const patch = {};
  for (const [key, value] of Object.entries(DEFAULTS)) {
    if (stored[key] === undefined) patch[key] = value;
  }
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

async function updateBadge() {
  const { enabled, subs, extras } = await chrome.storage.local.get(['enabled', 'subs', 'extras']);
  const on = enabled !== false;
  const count = Object.keys(subs || {}).length + Object.keys(extras || {}).length;
  let text = '';
  let color = '#5f6368';
  if (!on) {
    text = 'OFF';
  } else if (count === 0) {
    // On, but nothing is allowed yet: every video is blocked until a sync succeeds.
    text = '!';
    color = '#d93025';
  }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaults();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(updateBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.enabled || changes.subs || changes.extras)) updateBadge();
});
