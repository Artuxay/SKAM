// Модели распознавания речи для расшифровки голосовых (СКАМ 0.5.1) — в бакет models нашего сервера.
//
// Hugging Face из России не открывается, поэтому браузер берёт модель у нас:
//   https://api.skam-messenger.ru/storage/v1/object/public/models/<модель>/<файл>
// Хранилище принимает файлы до 50 МБ — большие режем на части по 40 МБ (<файл>.part0, .part1…).
// Список файлов, размеры и SHA-256 — в <модель>/manifest.json (приложение сверяет каждую часть).
//
// 1) Скачать и подготовить (нужен доступ к huggingface.co, то есть не из России):
//      node scripts/whisper-models.mjs prepare ./models-out whisper-base whisper-small
// 2) Загрузить в бакет (ключ service_role с сервера: grep SERVICE_ROLE_KEY /opt/supabase-project/.env):
//      node scripts/whisper-models.mjs upload ./models-out https://api.skam-messenger.ru <ключ>
//
// Модели: onnx-community/whisper-base и whisper-small (OpenAI Whisper, лицензия MIT), квантованные (q8).
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const FILES = [
  'config.json', 'generation_config.json', 'preprocessor_config.json', 'tokenizer.json', 'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx', 'onnx/decoder_model_merged_quantized.onnx',
];
const PART = 40 * 1024 * 1024;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const type = (f) => (f.endsWith('.json') ? 'application/json' : 'application/octet-stream');

async function prepare(out, models) {
  for (const model of models) {
    const files = {};
    for (const f of FILES) {
      const url = `https://huggingface.co/onnx-community/${model}/resolve/main/${f}`;
      process.stdout.write(`${model}/${f} … `);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const info = { size: buf.length, sha256: sha(buf), type: type(f) };
      if (buf.length > PART) {
        info.parts = [];
        for (let i = 0, k = 0; i < buf.length; i += PART, k++) {
          const part = buf.subarray(i, i + PART);
          const name = `${f}.part${k}`;
          await mkdir(dirname(join(out, model, name)), { recursive: true });
          await writeFile(join(out, model, name), part);
          info.parts.push({ name, size: part.length, sha256: sha(part) });
        }
      } else {
        await mkdir(dirname(join(out, model, f)), { recursive: true });
        await writeFile(join(out, model, f), buf);
      }
      files[f] = info;
      console.log(`${(buf.length / 1048576).toFixed(1)} МБ${info.parts ? `, ${info.parts.length} части` : ''}`);
    }
    const manifest = { model, source: `onnx-community/${model}`, license: 'MIT (OpenAI Whisper)', dtype: 'q8', files };
    await writeFile(join(out, model, 'manifest.json'), JSON.stringify(manifest, null, 1));
  }
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function upload(out, api, key) {
  const all = (await walk(out)).map((p) => p.slice(out.length + 1).replaceAll('\\', '/')).sort();
  // manifest.json — последним: пока его нет, приложение не начнёт качать неполную модель.
  all.sort((a, b) => Number(a.endsWith('manifest.json')) - Number(b.endsWith('manifest.json')));
  // SKAM_APIKEY — публичный ключ сайта, если загружаете токеном пользователя (а не ключом service_role).
  const apikey = process.env.SKAM_APIKEY ?? key;
  const upsert = process.env.SKAM_UPSERT === '0' ? 'false' : 'true';
  for (const rel of all) {
    const body = await readFile(join(out, rel));
    let res;
    for (let attempt = 1; ; attempt++) {
      try {
        res = await fetch(`${api.replace(/\/$/, '')}/storage/v1/object/models/${rel}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`, apikey, 'x-upsert': upsert,
            'cache-control': rel.endsWith('manifest.json') ? 'max-age=300' : 'max-age=31536000',
            'content-type': type(rel),
          },
          body,
        });
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        console.log(`${rel}: обрыв (${e.message}), ещё раз…`);
      }
    }
    console.log(`${rel}: ${res.status} ${(await stat(join(out, rel))).size} байт`);
    if (!res.ok && !(res.status === 409 || /exists|Duplicate/i.test(await res.clone().text()))) throw new Error(await res.text());
  }
}

const [cmd, a, b, c, ...rest] = process.argv.slice(2);
if (cmd === 'prepare' && a) await prepare(a, [b, c, ...rest].filter(Boolean).length ? [b, c, ...rest].filter(Boolean) : ['whisper-base']);
else if (cmd === 'upload' && a && b && c) await upload(a, b, c);
else console.log('node scripts/whisper-models.mjs prepare <папка> [whisper-base whisper-small]\nnode scripts/whisper-models.mjs upload <папка> <адрес API> <ключ>');
