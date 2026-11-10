#!/usr/bin/env node
import readline from 'node:readline';
import os from 'node:os';
import { ChatClient } from './client.js';
import { disguise, highlight, LANGS } from './disguise.js';
import { c, stripAnsi } from './colors.js';
import { deriveKey, newSalt, encrypt, decrypt, makeVerifier, verifyKey } from './crypto.js';

// ---------- args ----------
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [k, v] = argv[i].split('=');
    if (k === '--name' || k === '-n') out.name = v ?? argv[++i];
    else if (k === '--server' || k === '-s') out.server = v ?? argv[++i];
    else if (k === '--token' || k === '-t') out.token = v ?? argv[++i];
    else if (k === '--help' || k === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage: secret-chat [--name <you>] [--server wss://host] [--token <server token>]
  Env: CHAT_SERVER (default ws://localhost:4545), CHAT_TOKEN`);
  process.exit(0);
}
const SERVER = args.server || process.env.CHAT_SERVER || 'ws://localhost:4545';
const TOKEN = args.token || process.env.CHAT_TOKEN || '';
const DEFAULT_NAME = os.userInfo().username;
const MIN_PASSPHRASE = 8;

// ---------- state ----------
const state = {
  mode: 'boot', // boot | name | menu | create | newpass | newpass2 | pass | confirm | chat
  name: null,
  rooms: [],
  maxRooms: 2,
  room: null,
  messages: [],
  seq: 0,
  private: false,
  lang: 'js',
  pendingDelete: null,
  pendingCreate: null, // { name, passphrase? }
  pendingJoin: null, // room awaiting its passphrase
  keys: new Map(), // roomId -> AES key (in memory only, never sent anywhere)
};

const client = new ChatClient(SERVER);
const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: isTTY });

// Mask typing while entering passphrases.
const MASKED = new Set(['newpass', 'newpass2', 'pass']);
if (isTTY) {
  const writeOut = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => {
    if (!MASKED.has(state.mode)) return writeOut(s);
    const p = rl.getPrompt();
    if (s.startsWith(p)) return writeOut(p + '•'.repeat([...s.slice(p.length)].length));
    if (s === '\r\n' || s === '\n') return writeOut(s);
    writeOut('•'.repeat([...s].length));
  };
}

/** Drop the last submitted line from ↑ history (passphrases, private messages). */
function forgetLastLine(raw) {
  if (rl.history?.[0] === raw) rl.history.shift();
}

// ---------- output helpers ----------
/** Write lines above the prompt without re-prompting. */
function write(...lines) {
  if (isTTY) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  }
  for (const l of lines) process.stdout.write(l + '\n');
}

/** Write lines above the prompt, then restore the prompt and whatever the user was typing. */
function print(...lines) {
  write(...lines);
  if (state.mode !== 'boot') rl.prompt(true);
}

function clearScreen() {
  if (isTTY) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

function promptFor(mode) {
  switch (mode) {
    case 'name':
      return `Your name ${c.dim(`(${DEFAULT_NAME})`)}: `;
    case 'create':
      return 'New room name: ';
    case 'newpass':
      return `Passphrase for "${state.pendingCreate?.name}" ${c.dim('(share it with the other person yourself)')}: `;
    case 'newpass2':
      return 'Repeat passphrase: ';
    case 'pass':
      return `Passphrase for "${state.pendingJoin?.name}" ${c.dim('(empty to cancel)')}: `;
    case 'menu':
      return c.bold('rooms › ');
    case 'confirm':
      return c.red(`Delete room "${state.pendingDelete?.name}" and all its messages? (y/N) `);
    case 'chat': {
      const priv = state.private ? c.yellow(` [private:${state.lang}]`) : '';
      return `${c.cyan(state.room?.name ?? '')}${priv} › `;
    }
    default:
      return '> ';
  }
}

function setMode(mode) {
  state.mode = mode;
  rl.setPrompt(promptFor(mode));
  rl.prompt();
}

/** Remove the just-submitted input line from the screen (so private text doesn't linger). */
function eraseSubmittedLine(raw) {
  if (!isTTY) return;
  const cols = process.stdout.columns || 80;
  const len = stripAnsi(rl.getPrompt()).length + raw.length;
  const rows = Math.max(1, Math.ceil(len / cols));
  process.stdout.write(`\x1b[${rows}A\x1b[0J`);
}

// ---------- menu ----------
function menuLines() {
  const lines = [
    '',
    `${c.bold('  Secret Chat')}  ${c.dim(`rooms ${state.rooms.length}/${state.maxRooms} · messages vanish after 24h`)}`,
    '',
  ];
  state.rooms.forEach((r, i) => {
    const online = r.online ? c.green(`${r.online} online`) : c.dim('empty');
    lines.push(`   ${c.bold(i + 1 + ')')} ${r.name}  ${c.dim('·')} ${online}`);
  });
  const cmds = [`${c.bold('<number>')} join`];
  if (state.rooms.length < state.maxRooms) cmds.push(`${c.bold('n <name>')} new room`);
  cmds.push(`${c.bold('d <number>')} delete`, `${c.bold('r')} refresh`, `${c.bold('q')} quit`);
  lines.push('', c.dim('  ') + cmds.join(c.dim('  ·  ')), '');
  return lines;
}

function showMenu() {
  state.room = null;
  state.messages = [];
  state.pendingDelete = null;
  state.pendingCreate = null;
  state.pendingJoin = null;
  if (state.rooms.length === 0) {
    write('', c.dim("  No rooms yet. Let's create one."));
    return setMode('create');
  }
  write(...menuLines());
  setMode('menu');
}

async function onMenu(line) {
  let m;
  if (!line || line === 'h' || line === '?') {
    write(...menuLines());
    return rl.prompt();
  }
  if (/^\d+$/.test(line)) {
    const room = state.rooms[Number(line) - 1];
    if (!room) return print(c.red(`No room ${line}.`));
    return joinRoom(room);
  }
  if ((m = line.match(/^(?:n|new)(?:\s+(.+))?$/i))) {
    if (state.rooms.length >= state.maxRooms) {
      return print(c.red(`Room limit reached (${state.maxRooms}). Delete one first: d <number>`));
    }
    return m[1] ? startCreate(m[1]) : setMode('create');
  }
  if ((m = line.match(/^(?:d|del|delete)\s+(\d+)$/i))) {
    const room = state.rooms[Number(m[1]) - 1];
    if (!room) return print(c.red(`No room ${m[1]}.`));
    state.pendingDelete = room;
    return setMode('confirm');
  }
  if (/^(r|refresh)$/i.test(line)) {
    Object.assign(state, await client.request('list_rooms'));
    return showMenu();
  }
  if (/^(q|quit|exit)$/i.test(line)) return quit();
  print(c.red(`Unknown command "${line}".`) + c.dim(' Type ? for help.'));
}

// ---------- create room (name -> passphrase -> repeat) ----------
function startCreate(name) {
  if (state.rooms.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
    return print(c.red(`A room named "${name}" already exists.`));
  }
  state.pendingCreate = { name };
  setMode('newpass');
}

async function onCreate(line) {
  if (!line) return state.rooms.length ? showMenu() : rl.prompt();
  startCreate(line);
}

async function onNewPass(pass) {
  if (pass.length < MIN_PASSPHRASE) {
    return print(c.red(`Use at least ${MIN_PASSPHRASE} characters.`));
  }
  state.pendingCreate.passphrase = pass;
  setMode('newpass2');
}

async function onNewPass2(pass) {
  const pending = state.pendingCreate;
  if (pass !== pending.passphrase) {
    write(c.red("Passphrases don't match. Try again."));
    pending.passphrase = null;
    return setMode('newpass');
  }
  state.mode = 'busy';
  write(c.dim('  deriving key…'));
  const salt = newSalt();
  const key = await deriveKey(pass, salt);
  try {
    const room = await client.request('create_room', {
      name: pending.name,
      salt,
      verifier: makeVerifier(key),
    });
    state.keys.set(room.id, key);
    await enterRoom(room);
  } catch (err) {
    write(c.red('✖ ' + err.message));
    showMenu();
  }
}

// ---------- join room (passphrase -> verify -> join) ----------
async function joinRoom(room) {
  if (state.keys.has(room.id)) return enterRoom(room);
  state.pendingJoin = room;
  setMode('pass');
}

async function onPass(pass) {
  const room = state.pendingJoin;
  if (!pass) return showMenu();
  state.mode = 'busy';
  write(c.dim('  deriving key…'));
  const key = await deriveKey(pass, room.salt);
  if (!verifyKey(key, room.verifier)) {
    write(c.red('Wrong passphrase.'));
    return setMode('pass');
  }
  state.keys.set(room.id, key);
  await enterRoom(room);
}

async function onConfirm(line) {
  const target = state.pendingDelete;
  state.pendingDelete = null;
  if (!/^y(es)?$/i.test(line)) {
    write(c.dim('  Cancelled.'));
    return state.room ? setMode('chat') : showMenu();
  }
  const data = await client.request('delete_room', { roomId: target.id });
  Object.assign(state, data);
  state.keys.delete(target.id);
  write(c.yellow(`  Room "${target.name}" deleted.`));
  showMenu();
}

// ---------- chat ----------
const isHidden = (m) => state.private || m.private;

function renderMessage(m) {
  const mine = m.author === state.name;
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const who = mine ? c.cyan(m.author) : c.magenta(m.author);
  const head = `${c.dim(time)} ${c.dim('#' + m.seq)} ${who}${m.private ? c.yellow(' 🔒') : ''}`;

  if (!isHidden(m)) return [`${head}: ${m.body}`];

  if (m.broken) return [`${head}: ${c.red(m.body)}`];

  if (m.snippetLang !== state.lang) {
    m.snippet = disguise(m.body, state.lang);
    m.snippetLang = state.lang;
  }
  return [
    `${head} ${c.dim(`(/r ${m.seq} to reveal)`)}`,
    ...highlight(m.snippet)
      .split('\n')
      .map((l) => c.dim('  │ ') + l.replace(/\t/g, '    ')),
  ];
}

/** Decrypt a server message ({ body: ciphertext }) into { author, body, private }. */
function addMessage(m) {
  const key = state.keys.get(m.roomId);
  let plain;
  try {
    const env = decrypt(key, m.body);
    plain = { author: String(env.a ?? m.author), body: String(env.b ?? ''), private: Boolean(env.p) };
  } catch {
    plain = { author: m.author, body: '[could not decrypt this message]', private: false, broken: true };
  }
  const msg = { id: m.id, roomId: m.roomId, createdAt: m.createdAt, ...plain, seq: ++state.seq };
  state.messages.push(msg);
  return msg;
}

function chatHeader() {
  const mode = state.private
    ? c.yellow(`private mode ON (${state.lang}) — /r <n> reveals a message`)
    : c.dim('private mode off — /p to turn on');
  return [
    c.bold(`── ${state.room.name} `) + c.dim('─'.repeat(Math.max(0, 40 - state.room.name.length))),
    c.dim('🔐 end-to-end encrypted · messages vanish after 24h · /help · ') + mode,
    '',
  ];
}

/** Clear the screen and redraw the whole conversation in the current mode. */
function redraw() {
  clearScreen();
  write(...chatHeader(), ...state.messages.flatMap(renderMessage));
  rl.setPrompt(promptFor('chat'));
  rl.prompt(true);
}

async function enterRoom(target) {
  const { room, history } = await client.request('join', { roomId: target.id });
  state.room = room;
  state.messages = [];
  state.seq = 0;
  history.forEach(addMessage);
  state.mode = 'chat';
  redraw();
}

function reveal(arg) {
  let m;
  if (arg) {
    m = state.messages.find((x) => x.seq === Number(String(arg).replace('#', '')));
    if (!m) return print(c.red(`No message #${arg}.`));
  } else {
    m = state.messages.findLast(isHidden);
    if (!m) return print(c.dim('Nothing hidden to reveal.'));
  }
  print(`  ${c.dim('↳ #' + m.seq)} ${c.bold(m.author)}: ${m.body}`);
}

const HELP = [
  '',
  c.bold('  Chat commands'),
  `   ${c.bold('/p')}, /private        toggle private mode (hides everything as code)`,
  `   ${c.bold('/lang')} <${LANGS.join('|')}>   language used to disguise messages`,
  `   ${c.bold('/r')} [n], /reveal     reveal message #n (default: latest hidden one)`,
  `   ${c.bold('/c')}, /clear          redraw screen (hides anything you revealed)`,
  `   ${c.bold('/rooms')}, /leave      back to the room list`,
  `   ${c.bold('/delete')}             delete this room and all its messages`,
  `   ${c.bold('/q')}, /quit           exit`,
  '',
];

async function onChat(raw) {
  const line = raw.trim();
  if (!line) return rl.prompt();

  if (!line.startsWith('/')) {
    eraseSubmittedLine(raw);
    if (state.private) forgetLastLine(raw); // keep private text out of ↑ history
    const key = state.keys.get(state.room.id);
    const body = encrypt(key, { a: state.name, b: line, p: state.private });
    await client.request('message', { body });
    return;
  }

  const [cmd, ...rest] = line.slice(1).split(/\s+/);
  switch (cmd.toLowerCase()) {
    case 'h':
    case 'help':
    case '?':
      return print(...HELP);
    case 'p':
    case 'private':
      state.private = !state.private;
      return redraw();
    case 'lang': {
      const lang = (rest[0] || '').toLowerCase();
      if (!LANGS.includes(lang)) return print(c.red(`Pick one of: ${LANGS.join(', ')}`));
      state.lang = lang;
      return redraw();
    }
    case 'r':
    case 'reveal':
      return reveal(rest[0]);
    case 'c':
    case 'clear':
      return redraw();
    case 'rooms':
    case 'leave':
    case 'back':
      Object.assign(state, await client.request('leave'));
      Object.assign(state, await client.request('list_rooms'));
      clearScreen();
      return showMenu();
    case 'delete':
      state.pendingDelete = state.room;
      return setMode('confirm');
    case 'q':
    case 'quit':
    case 'exit':
      return quit();
    default:
      return print(c.red(`Unknown command /${cmd}.`) + c.dim(' Type /help.'));
  }
}

// ---------- server events ----------
client.on('message', (m) => {
  if (state.room?.id !== m.roomId) return;
  const msg = addMessage(m);
  if (state.mode === 'chat') print(...renderMessage(msg));
});

client.on('presence', ({ roomId, name, action }) => {
  if (state.room?.id !== roomId || name === state.name || state.mode !== 'chat') return;
  print(c.dim(`  · ${name} ${action}`));
});

client.on('rooms', ({ rooms, maxRooms }) => {
  const ids = (list) => list.map((r) => `${r.id}:${r.name}`).join(',');
  const changed = ids(rooms) !== ids(state.rooms);
  state.rooms = rooms;
  state.maxRooms = maxRooms;
  if (changed && state.mode === 'menu') {
    write(...menuLines());
    rl.prompt(true);
  }
});

client.on('room_deleted', ({ roomId, name, by }) => {
  if (state.room?.id !== roomId) return;
  state.rooms = state.rooms.filter((r) => r.id !== roomId);
  state.keys.delete(roomId);
  clearScreen();
  write(c.yellow(`  Room "${name}" was deleted by ${by === state.name ? 'you' : by}.`));
  showMenu();
});

client.on('expired', ({ cutoff }) => {
  state.messages = state.messages.filter((m) => m.createdAt >= cutoff);
});

client.on('disconnect', () => {
  write('', c.red('Disconnected from server.'));
  process.exit(1);
});

// ---------- main ----------
async function onName(line) {
  const data = await client.request('hello', { name: line || DEFAULT_NAME, token: TOKEN });
  state.name = data.name;
  state.rooms = data.rooms;
  state.maxRooms = data.maxRooms;
  showMenu();
}

const routes = {
  name: onName,
  menu: onMenu,
  create: onCreate,
  newpass: onNewPass,
  newpass2: onNewPass2,
  pass: onPass,
  confirm: onConfirm,
  chat: onChat,
};

rl.on('line', async (raw) => {
  const route = routes[state.mode];
  if (!route) return;
  if (MASKED.has(state.mode)) forgetLastLine(raw);
  try {
    // Passphrases are used exactly as typed; everything else is trimmed.
    await route(state.mode === 'chat' || MASKED.has(state.mode) ? raw : raw.trim());
  } catch (err) {
    print(c.red('✖ ' + err.message));
  }
});

let quitting = false;
function quit() {
  if (quitting) return;
  quitting = true;
  write(c.dim('bye 👋'));
  client.close();
  rl.close();
  process.exit(0);
}
rl.on('close', quit);

async function main() {
  try {
    await client.connect();
  } catch (err) {
    console.error(c.red(`Could not connect to ${SERVER} (${err.code || err.message}).`));
    console.error(c.dim('Is the server running? Start it with: npm run server'));
    process.exit(1);
  }
  const { protocol, hostname } = new URL(SERVER);
  if (protocol === 'ws:' && !['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname)) {
    write(c.yellow('⚠ Not using TLS (ws://). Messages are still end-to-end encrypted, but names'));
    write(c.yellow('  and room names are visible on the network. Use wss:// for a hosted server.'));
  }
  if (args.name) {
    state.mode = 'name';
    try {
      await onName(args.name);
    } catch (err) {
      console.error(c.red(err.message));
      process.exit(1);
    }
  } else {
    setMode('name');
  }
}

main();
