const $ = (id) => document.getElementById(id);
const UC_RE = /^UC[\w-]{22}$/;
const ORIGIN = 'https://www.youtube.com';

function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Turns whatever was typed into a channel page URL, or a bare channel ID.
function parseInput(raw) {
  const text = raw.trim();
  if (!text) return null;
  if (UC_RE.test(text)) return { id: text, url: `${ORIGIN}/channel/${text}` };
  if (/^@[\w.-]+$/.test(text)) return { url: `${ORIGIN}/${text}` };
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
  const idMatch = url.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (idMatch) return { id: idMatch[1], url: `${ORIGIN}/channel/${idMatch[1]}` };
  const pathMatch = url.pathname.match(/^\/(@[\w.-]+|c\/[^/]+|user\/[^/]+)/);
  return pathMatch ? { url: `${ORIGIN}/${pathMatch[1]}` } : null;
}

// Loads the channel page to learn its permanent ID and name.
async function resolveChannel(target) {
  let html = '';
  try {
    const res = await fetch(target.url, { credentials: 'include' });
    if (res.ok) html = await res.text();
  } catch {}
  const id =
    target.id ||
    (html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) || [])[1] ||
    (html.match(/"externalId":"(UC[\w-]{22})"/) || [])[1];
  if (!id) return null;
  const title = decodeEntities((html.match(/<meta property="og:title" content="([^"]*)"/) || [])[1] || '');
  const handle = (html.match(/"canonicalBaseUrl":"\/(@[^"]+)"/) || [])[1] || '';
  return { id, title, handle };
}

function row(id, info, onRemove) {
  const li = document.createElement('li');
  const name = document.createElement('span');
  name.className = 'name';
  const link = document.createElement('a');
  link.href = `${ORIGIN}/channel/${id}`;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = info.title || info.handle || id;
  name.append(link);
  li.append(name);
  if (info.handle && info.title) {
    const handle = document.createElement('span');
    handle.className = 'id';
    handle.textContent = info.handle;
    li.append(handle);
  }
  if (onRemove) {
    const button = document.createElement('button');
    button.className = 'secondary';
    button.textContent = 'Remove';
    button.addEventListener('click', onRemove);
    li.append(button);
  }
  return li;
}

function emptyRow(text) {
  const li = document.createElement('li');
  li.className = 'empty';
  li.textContent = text;
  return li;
}

const byName = ([, a], [, b]) =>
  (a.title || a.handle || '').localeCompare(b.title || b.handle || '', undefined, { sensitivity: 'base' });

async function render() {
  const { subs = {}, extras = {} } = await chrome.storage.local.get(['subs', 'extras']);

  const extraEntries = Object.entries(extras).sort(byName);
  $('extrasHeading').textContent = `Added by hand (${extraEntries.length})`;
  $('extras').replaceChildren(
    ...(extraEntries.length
      ? extraEntries.map(([id, info]) => row(id, info, () => removeExtra(id)))
      : [emptyRow('None yet.')])
  );

  const query = $('filter').value.trim().toLowerCase();
  const subEntries = Object.entries(subs).sort(byName);
  const shown = query
    ? subEntries.filter(([id, info]) => `${info.title} ${info.handle} ${id}`.toLowerCase().includes(query))
    : subEntries;
  $('subsHeading').textContent = `From your subscriptions (${subEntries.length})`;
  let placeholder = '';
  if (!subEntries.length) placeholder = 'Nothing synced yet. Open YouTube while signed in, or press "Sync now" in the popup.';
  else if (!shown.length) placeholder = 'No channel matches that filter.';
  $('subs').replaceChildren(...(placeholder ? [emptyRow(placeholder)] : shown.map(([id, info]) => row(id, info))));
}

async function removeExtra(id) {
  const { extras = {} } = await chrome.storage.local.get('extras');
  delete extras[id];
  await chrome.storage.local.set({ extras });
}

$('addForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = $('addStatus');
  const target = parseInput($('addInput').value);
  if (!target) {
    status.textContent = 'Enter a YouTube channel link, an @handle, or a channel ID starting with UC.';
    return;
  }
  $('addButton').disabled = true;
  status.textContent = 'Looking up the channel…';
  try {
    const channel = await resolveChannel(target);
    if (!channel) {
      status.textContent = 'Could not find that channel. Try pasting its channel ID (starts with UC).';
      return;
    }
    const { extras = {} } = await chrome.storage.local.get('extras');
    extras[channel.id] = { title: channel.title, handle: channel.handle };
    await chrome.storage.local.set({ extras });
    $('addInput').value = '';
    status.textContent = `Added ${channel.title || channel.id}.`;
  } finally {
    $('addButton').disabled = false;
  }
});

$('filter').addEventListener('input', render);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.subs || changes.extras)) render();
});

render();
