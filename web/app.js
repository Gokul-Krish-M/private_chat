import { deriveKey, newSalt, encrypt, decrypt, makeVerifier, verifyKey } from './crypto.js';
import { ARTICLES } from './articles.js';
import { fakeAd, hueOf } from './ads.js';

// Disguise map:
//   search box          -> chat input (inside a collection) / real in-article search (outside)
//   "Sponsored" ad rail -> messages
//   Collections         -> rooms, "access code" = room passphrase
//   Sign in             -> username = display name, password = server CHAT_TOKEN
//   AdChoices / Esc     -> private mode (every ad shows fake copy; click an ad to reveal it)

const SESSION_KEY = 'margins.session';
const ARTICLE_KEY = 'margins.article';
const REVEAL_MS = 8000;
const MIN_PASSPHRASE = 8;

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') for (const [prop, val] of Object.entries(v)) node.style.setProperty(prop, val);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k in node) node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children.flat()) if (child != null && child !== false) node.append(child);
  return node;
}

function svg(markup, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="${cls}" viewBox="0 0 16 16" aria-hidden="true">${markup}</svg>`;
  return t.content.firstElementChild;
}
const ICON_LOCK = '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>';
const ICON_OPEN = '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 4.9-.7"/>';
const ICON_TRASH = '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>';

// ---------- state ----------
const state = {
  name: null,
  token: '',
  rooms: [],
  maxRooms: 2,
  room: null,
  keys: new Map(), // roomId -> CryptoKey (memory only)
  messages: [],
  private: false,
};

// ---------- connection ----------
class Connection {
  #ws = null;
  #seq = 0;
  #pending = new Map();
  #listeners = new Map();

  get isOpen() {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  open() {
    if (this.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}`);
      let opened = false;
      this.#ws = ws;
      ws.onopen = () => {
        opened = true;
        resolve();
      };
      ws.onerror = () => {
        if (!opened) reject(new Error('Unable to reach the library right now.'));
      };
      ws.onmessage = (e) => this.#onMessage(e.data);
      ws.onclose = () => {
        for (const p of this.#pending.values()) p.reject(new Error('Connection lost.'));
        this.#pending.clear();
        if (opened) this.#emit('disconnect');
      };
    });
  }

  close() {
    this.#ws?.close();
  }

  request(type, payload = {}) {
    if (!this.isOpen) return Promise.reject(new Error('Not connected.'));
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('The request timed out.'));
      }, 15000);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  on(event, fn) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, []);
    this.#listeners.get(event).push(fn);
  }

  #emit(event, data) {
    for (const fn of this.#listeners.get(event) ?? []) fn(data);
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.re != null) {
      const p = this.#pending.get(msg.re);
      if (!p) return;
      this.#pending.delete(msg.re);
      msg.ok ? p.resolve(msg.data) : p.reject(new Error(msg.error));
    } else if (msg.event) {
      this.#emit(msg.event, msg.data);
    }
  }
}

const conn = new Connection();

// ---------- status line ----------
let statusTimer;
function setStatus(text, sticky = false) {
  clearTimeout(statusTimer);
  $('#status').textContent = text;
  if (text && !sticky) statusTimer = setTimeout(() => ($('#status').textContent = ''), 5000);
}

// ---------- modal ----------
function modal({ title, text, fields = [], submit = 'Continue', danger = false, validate }) {
  return new Promise((resolve) => {
    const dlg = $('#modal');
    const err = el('p', { class: 'modal-err', role: 'alert' });
    const ok = el('button', { type: 'submit', class: danger ? 'btn danger' : 'btn primary' }, submit);
    const cancel = el('button', { type: 'button', class: 'btn', onclick: () => dlg.close() }, 'Cancel');
    const form = el(
      'form',
      { method: 'dialog', autocomplete: 'off' },
      el('h2', {}, title),
      text ? el('p', { class: 'modal-text' }, text) : null,
      fields.map((f) =>
        el(
          'label',
          { class: 'field' },
          el('span', {}, f.label),
          el('input', {
            name: f.name,
            type: f.type || 'text',
            autocomplete: f.autocomplete || 'off',
            required: f.required !== false,
            value: f.value || '',
            maxLength: f.maxLength || 200,
            spellcheck: false,
          }),
        ),
      ),
      err,
      el('div', { class: 'modal-actions' }, cancel, ok),
    );

    let settled = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(new FormData(form));
      const label = ok.textContent;
      ok.disabled = true;
      ok.textContent = 'Please wait…';
      err.textContent = '';
      try {
        const problem = validate ? await validate(values) : null;
        if (problem) {
          err.textContent = problem;
          return;
        }
        settled = true;
        dlg.close();
        resolve(values);
      } catch (ex) {
        err.textContent = ex.message;
      } finally {
        ok.disabled = false;
        ok.textContent = label;
      }
    });

    dlg.replaceChildren(form);
    dlg.addEventListener('close', () => settled || resolve(null), { once: true });
    dlg.showModal();
    form.querySelector('input')?.focus();
  });
}

// ---------- articles (cover content) ----------
function renderArticleList(activeSlug) {
  $('#articles').replaceChildren(
    ...ARTICLES.map((a) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: 'item' + (a.slug === activeSlug ? ' active' : ''),
            onclick: () => showArticle(a.slug),
          },
          el('span', { class: 'label' }, a.title),
        ),
      ),
    ),
  );
}

function showArticle(slug) {
  const a = ARTICLES.find((x) => x.slug === slug) ?? ARTICLES[0];
  try {
    localStorage.setItem(ARTICLE_KEY, a.slug);
  } catch {}
  const blocks = a.body.map((b) => {
    if (b.h) return el('h2', {}, b.h);
    if (b.q) return el('blockquote', {}, b.q);
    if (b.ul) return el('ul', {}, b.ul.map((i) => el('li', {}, i)));
    return el('p', {}, b.p);
  });
  $('#article').replaceChildren(
    el('div', { class: 'kicker' }, a.kicker),
    el('h1', {}, a.title),
    el('p', { class: 'dek' }, a.dek),
    el(
      'div',
      { class: 'byline' },
      el('span', {}, 'By ', el('strong', {}, a.author)),
      el('span', {}, '·'),
      el('span', {}, `${a.minutes} min read`),
      el('span', {}, '·'),
      el('span', {}, `Updated ${a.updated}`),
    ),
    ...blocks,
  );
  document.title = `${a.title} · Margins`;
  renderArticleList(a.slug);
  window.scrollTo({ top: 0 });
}

function clearSearch() {
  $('#q').value = '';
  const root = $('#article');
  for (const m of root.querySelectorAll('mark')) m.replaceWith(m.textContent);
  root.normalize();
}

/** Outside a collection, the search box really searches the article. */
function searchArticle(query) {
  const root = $('#article');
  for (const m of root.querySelectorAll('mark')) m.replaceWith(m.textContent);
  root.normalize();
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  let first = null;
  for (const node of nodes) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    let i = lower.indexOf(needle);
    if (i === -1) continue;
    const frag = document.createDocumentFragment();
    let last = 0;
    while (i !== -1) {
      frag.append(text.slice(last, i));
      const mark = el('mark', {}, text.slice(i, i + needle.length));
      first ??= mark;
      frag.append(mark);
      count++;
      last = i + needle.length;
      i = lower.indexOf(needle, last);
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
  first?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setStatus(count ? `${count} result${count === 1 ? '' : 's'} in this article` : `No results for “${query}”`);
}

// ---------- account ----------
function renderAccount() {
  const btn = $('#account');
  if (!state.name) {
    btn.replaceChildren('Sign in');
    return;
  }
  btn.replaceChildren(el('span', { class: 'avatar' }, state.name[0].toUpperCase()), state.name);
}

async function hello(name, token) {
  await conn.open();
  const data = await conn.request('hello', { name, token });
  state.name = data.name;
  state.token = token;
  state.rooms = data.rooms;
  state.maxRooms = data.maxRooms;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ name: data.name, token }));
  } catch {}
  renderAccount();
  renderRooms();
}

async function onAccountClick() {
  if (state.name) {
    const out = await modal({
      title: `Signed in as ${state.name}`,
      text: 'Signing out closes any open collections on this device.',
      submit: 'Sign out',
    });
    if (out) signOut();
    return;
  }
  await modal({
    title: 'Sign in to Margins',
    text: 'Pick up where you left off and access your collections.',
    fields: [
      { name: 'name', label: 'Username', autocomplete: 'username', maxLength: 24 },
      { name: 'token', label: 'Password', type: 'password', autocomplete: 'current-password', required: false },
    ],
    submit: 'Sign in',
    validate: async ({ name, token }) => {
      try {
        await hello(name.trim(), token);
      } catch (err) {
        return /token/i.test(err.message) ? 'Incorrect username or password.' : err.message;
      }
    },
  });
}

function signOut() {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {}
  location.reload();
}

// ---------- collections (rooms) ----------
function renderRooms() {
  $('#collections').hidden = !state.name;
  $('#new-room').hidden = state.rooms.length >= state.maxRooms;
  $('#rooms').replaceChildren(
    ...state.rooms.map((room) => {
      const active = state.room?.id === room.id;
      const unlocked = state.keys.has(room.id);
      return el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            class: 'item' + (active ? ' active' : ''),
            title: active ? 'Close collection' : 'Open collection',
            onclick: () => (active ? closeRoom() : openRoom(room)),
          },
          svg(unlocked ? ICON_OPEN : ICON_LOCK),
          el('span', { class: 'label' }, room.name),
          room.online ? el('span', { class: 'meta' }, `${room.online} reading`) : null,
        ),
        el(
          'button',
          { type: 'button', class: 'remove', title: 'Remove collection', onclick: () => removeRoom(room) },
          svg(ICON_TRASH),
        ),
      );
    }),
  );
  $('#q').placeholder = state.room ? `Search ${state.room.name}…` : 'Search the library…';
}

async function openRoom(room) {
  if (!state.keys.has(room.id)) {
    const ok = await modal({
      title: `“${room.name}” is restricted`,
      text: 'Enter the access code to open this collection.',
      fields: [{ name: 'code', label: 'Access code', type: 'password' }],
      submit: 'Open',
      validate: async ({ code }) => {
        const key = await deriveKey(code, room.salt);
        if (!(await verifyKey(key, room.verifier))) return 'That access code is not valid.';
        state.keys.set(room.id, key);
      },
    });
    if (!ok) return;
  }
  try {
    await enterRoom(room.id);
  } catch (err) {
    setStatus(err.message);
  }
}

async function enterRoom(roomId) {
  const { room, history } = await conn.request('join', { roomId });
  state.room = room;
  state.messages = await Promise.all(history.map(decryptMessage));
  clearSearch(); // never send a leftover search query as a message
  renderRooms();
  renderAds();
}

async function closeRoom() {
  state.room = null;
  state.messages = [];
  clearSearch();
  renderRooms();
  renderAds();
  try {
    await conn.request('leave');
  } catch {}
}

async function createRoom() {
  await modal({
    title: 'New collection',
    text: 'Collections are private. Share the access code only with people you trust. It cannot be recovered.',
    fields: [
      { name: 'name', label: 'Name', maxLength: 32 },
      { name: 'code', label: 'Access code', type: 'password', autocomplete: 'new-password' },
      { name: 'code2', label: 'Confirm access code', type: 'password', autocomplete: 'new-password' },
    ],
    submit: 'Create',
    validate: async ({ name, code, code2 }) => {
      if (!name.trim()) return 'Give the collection a name.';
      if (code.length < MIN_PASSPHRASE) return `Use at least ${MIN_PASSPHRASE} characters for the access code.`;
      if (code !== code2) return 'The access codes don’t match.';
      const salt = newSalt();
      const key = await deriveKey(code, salt);
      const room = await conn.request('create_room', { name: name.trim(), salt, verifier: await makeVerifier(key) });
      state.keys.set(room.id, key);
      await enterRoom(room.id);
    },
  });
}

async function removeRoom(room) {
  const ok = await modal({
    title: `Remove “${room.name}”?`,
    text: 'This permanently deletes the collection and everything in it, for everyone.',
    submit: 'Remove',
    danger: true,
  });
  if (!ok) return;
  try {
    const data = await conn.request('delete_room', { roomId: room.id });
    state.rooms = data.rooms;
    state.keys.delete(room.id);
    if (state.room?.id === room.id) {
      state.room = null;
      state.messages = [];
      renderAds();
    }
    renderRooms();
    setStatus(`Removed “${room.name}”`);
  } catch (err) {
    setStatus(err.message);
  }
}

// ---------- messages as ads ----------
async function decryptMessage(m) {
  const base = { id: m.id, roomId: m.roomId, createdAt: m.createdAt };
  try {
    const env = await decrypt(state.keys.get(m.roomId), m.body);
    return { ...base, author: String(env.a ?? m.author), body: String(env.b ?? ''), private: Boolean(env.p) };
  } catch {
    return { ...base, author: m.author, body: 'This message could not be decrypted.', private: false, broken: true };
  }
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function adCard(m, { reveal = false, swap = false } = {}) {
  const veiled = (state.private || m.private) && !reveal;
  const mine = m.author === state.name;
  const fake = fakeAd(m.id);
  const brand = veiled ? fake.brand : m.author;
  const card = el(
    'article',
    {
      class: ['ad', veiled && 'veiled', reveal && 'revealed', m.broken && 'broken', swap && 'swap']
        .filter(Boolean)
        .join(' '),
      dataset: { id: m.id },
    },
    el(
      'div',
      { class: 'ad-top' },
      el('span', { class: 'ad-logo', style: { '--h': hueOf(brand) } }, brand.slice(0, 1).toUpperCase()),
      el('span', { class: 'ad-brand' }, brand),
      el('span', { class: 'ad-badge' }, mine ? 'Promoted' : 'Sponsored'),
    ),
    el('p', { class: 'ad-copy' }, veiled ? fake.copy : m.body),
    el(
      'div',
      { class: 'ad-foot' },
      el('span', { class: 'ad-cta' }, veiled ? fake.cta : 'Learn more'),
      el('time', { dateTime: new Date(m.createdAt).toISOString() }, fmtTime(m.createdAt)),
    ),
  );

  if (veiled) {
    // Click to reveal for a few seconds, click again (or wait) to hide.
    card.addEventListener('click', () => {
      const shown = adCard(m, { reveal: true, swap: true });
      card.replaceWith(shown);
      const hide = () => shown.isConnected && shown.replaceWith(adCard(m, { swap: true }));
      const timer = setTimeout(hide, REVEAL_MS);
      shown.addEventListener('click', () => (clearTimeout(timer), hide()));
    });
  }
  return card;
}

function fillerAds(count) {
  const day = Math.floor(Date.now() / 86400000);
  return Array.from({ length: count }, (_, i) => {
    const f = fakeAd(day * 7 + i);
    return el(
      'article',
      { class: 'ad filler' },
      el(
        'div',
        { class: 'ad-top' },
        el('span', { class: 'ad-logo', style: { '--h': hueOf(f.brand) } }, f.brand[0]),
        el('span', { class: 'ad-brand' }, f.brand),
        el('span', { class: 'ad-badge' }, 'Sponsored'),
      ),
      el('p', { class: 'ad-copy' }, f.copy),
      el('div', { class: 'ad-foot' }, el('span', { class: 'ad-cta' }, f.cta)),
    );
  });
}

function scrollAdsToEnd() {
  const box = $('#ads');
  box.scrollTop = box.scrollHeight;
}

function renderAds() {
  const box = $('#ads');
  if (!state.room) return box.replaceChildren(...fillerAds(3));
  if (!state.messages.length) return box.replaceChildren(...fillerAds(1));
  box.replaceChildren(...state.messages.map((m) => adCard(m)));
  scrollAdsToEnd();
}

function appendAd(m) {
  const box = $('#ads');
  box.querySelectorAll('.filler').forEach((n) => n.remove());
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.append(adCard(m));
  if (nearBottom || m.author === state.name) scrollAdsToEnd();
}

function setPrivate(on) {
  state.private = on;
  $('#adchoices').classList.toggle('on', on);
  if (state.room) renderAds();
}

// ---------- sending (the search box) ----------
async function onSearchSubmit(e) {
  e.preventDefault();
  const input = $('#q');
  const text = input.value.trim();
  if (!text) return;

  if (!state.room) return searchArticle(text);

  input.value = '';
  try {
    const body = await encrypt(state.keys.get(state.room.id), { a: state.name, b: text, p: state.private });
    await conn.request('message', { body });
  } catch (err) {
    input.value = text;
    setStatus(err.message);
  }
}

// ---------- server events ----------
conn.on('rooms', ({ rooms, maxRooms }) => {
  state.rooms = rooms;
  state.maxRooms = maxRooms;
  renderRooms();
});

conn.on('message', async (m) => {
  if (state.room?.id !== m.roomId) return;
  const msg = await decryptMessage(m);
  if (state.room?.id !== m.roomId) return;
  state.messages.push(msg);
  appendAd(msg);
});

conn.on('room_deleted', ({ roomId, name }) => {
  state.keys.delete(roomId);
  if (state.room?.id === roomId) {
    state.room = null;
    state.messages = [];
    renderAds();
    setStatus(`“${name}” was removed`);
  }
  renderRooms();
});

conn.on('expired', ({ cutoff }) => {
  const before = state.messages.length;
  state.messages = state.messages.filter((m) => m.createdAt >= cutoff);
  if (state.messages.length !== before) renderAds();
});

conn.on('disconnect', () => {
  if (!state.name) return;
  setStatus('Syncing…', true);
  reconnect(1000);
});

async function reconnect(delay) {
  await new Promise((r) => setTimeout(r, delay));
  try {
    const roomId = state.room?.id;
    await hello(state.name, state.token);
    if (roomId != null && state.rooms.some((r) => r.id === roomId)) await enterRoom(roomId);
    else if (roomId != null) closeRoom();
    setStatus('');
  } catch {
    reconnect(Math.min(delay * 2, 30000));
  }
}

// ---------- boot ----------
function boot() {
  let slug;
  try {
    slug = localStorage.getItem(ARTICLE_KEY);
  } catch {}
  showArticle(slug);
  renderAds();
  renderAccount();

  $('#search').addEventListener('submit', onSearchSubmit);
  $('#account').addEventListener('click', onAccountClick);
  $('#new-room').addEventListener('click', createRoom);
  $('#adchoices').addEventListener('click', () => setPrivate(!state.private));
  $('#home').addEventListener('click', (e) => {
    e.preventDefault();
    showArticle(ARTICLES[0].slug);
  });

  // Panic key: Esc instantly veils every message.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modal').open) setPrivate(true);
  });

  if (!window.isSecureContext) {
    setStatus('Collections need HTTPS.', true);
  }

  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {}
  if (saved?.name) {
    hello(saved.name, saved.token ?? '').catch(() => {
      try {
        sessionStorage.removeItem(SESSION_KEY);
      } catch {}
    });
  }
}

boot();
