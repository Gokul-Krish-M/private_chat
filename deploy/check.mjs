// Smoke test for a deployed backend:
//   CHAT_SERVER=wss://chat.example.com CHAT_TOKEN=... node deploy/check.mjs
import { ChatClient } from '../src/client.js';

const url = process.env.CHAT_SERVER || 'ws://127.0.0.1:4545';
const client = new ChatClient(url);
try {
  await client.connect();
  const data = await client.request('hello', { name: 'healthcheck', token: process.env.CHAT_TOKEN || '' });
  console.log(`OK ${url}: ${data.rooms.length}/${data.maxRooms} rooms, messages expire after ${data.ttlMs / 3600000}h`);
  client.close();
  process.exit(0);
} catch (err) {
  console.error(`FAIL ${url}: ${err.code || err.message}`);
  process.exit(1);
}
