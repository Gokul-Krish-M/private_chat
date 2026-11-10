import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/**
 * Thin request/response + event wrapper around the chat WebSocket protocol.
 *   request:  { id, type, ...payload }      -> reply { re: id, ok, data | error }
 *   events:   { event, data }               -> emitted as client.on(event, data)
 */
export class ChatClient extends EventEmitter {
  #ws = null;
  #seq = 0;
  #pending = new Map();

  constructor(url) {
    super();
    this.url = url;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      let opened = false;
      this.#ws = ws;

      ws.on('open', () => {
        opened = true;
        resolve();
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
      });
      ws.on('message', (raw) => this.#onMessage(raw));
      ws.on('close', () => {
        for (const { reject: rej } of this.#pending.values()) rej(new Error('Connection closed.'));
        this.#pending.clear();
        if (opened) this.emit('disconnect');
      });
    });
  }

  request(type, payload = {}) {
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Request "${type}" timed out.`));
      }, 10_000);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  close() {
    this.#ws?.close();
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
      this.emit(msg.event, msg.data);
    }
  }
}
