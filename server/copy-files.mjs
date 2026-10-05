// Copies Storage files from Supabase Cloud to the SKAM server
import { readFileSync } from 'node:fs';
const CLOUD = process.env.CLOUD_URL
  || 'https://fsqbxvufqhghiwwzplpn.supabase.co/storage/v1/object/';
const LOCAL = process.env.LOCAL_URL
  || 'https://api.skam-messenger.ru/storage/v1/object/';
const ck = process.env.CLOUD_KEY;
const lk = process.env.LOCAL_KEY;
// New sb_ keys go only in apikey, legacy JWT keys go in both headers
const hdr = (k) => (k.startsWith('sb_')
  ? { apikey: k }
  : { apikey: k, authorization: `Bearer ${k}` });
const cloudH = hdr(ck);
const localH = hdr(lk);
const list = JSON.parse(readFileSync('objects.json', 'utf8'));
let ok = 0;
let fail = 0;
for (const o of list) {
  const enc = o.n.split('/').map(encodeURIComponent).join('/');
  const path = `${o.b}/${enc}`;
  try {
    const r = await fetch(CLOUD + path, { headers: cloudH });
    if (!r.ok) {
      throw new Error(`cloud ${r.status} ${(await r.text()).slice(0, 150)}`);
    }
    const body = Buffer.from(await r.arrayBuffer());
    const h = {
      ...localH,
      'content-type': o.t || 'application/octet-stream',
      'x-upsert': 'true',
    };
    if (o.c) h['cache-control'] = o.c;
    const u = await fetch(LOCAL + path, { method: 'POST', headers: h, body });
    if (!u.ok) {
      throw new Error(`server ${u.status} ${(await u.text()).slice(0, 150)}`);
    }
    ok++;
    console.log(`ok   ${o.b}/${o.n} (${body.length} B)`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${o.b}/${o.n}: ${e.message}`);
  }
}
console.log(`Done: ${ok} ok, ${fail} failed`);
process.exit(fail ? 1 : 0);
