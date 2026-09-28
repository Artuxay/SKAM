// Письмо в поддержку: тема, текст и HTML из строки support_requests.

export type SupportRow = {
  id: string;
  user_id: string;
  email: string | null;
  name: string | null;
  username: string | null;
  topic: string;
  body: string;
  meta: Record<string, unknown> | null;
  created_at: string;
};

export const TOPICS: Record<string, string> = {
  bug: 'Ошибка',
  question: 'Вопрос',
  idea: 'Идея',
  other: 'Другое',
};

/** Какие данные об устройстве принимаем от приложения (всё — строки, коротко). */
const META_KEYS: Record<string, string> = {
  app: 'Версия СКАМ',
  ua: 'Браузер',
  platform: 'Система',
  lang: 'Язык',
  screen: 'Экран',
  tz: 'Часовой пояс',
  mode: 'Запуск',
  theme: 'Тема',
  net: 'Сеть',
};

export function cleanMeta(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const k of Object.keys(META_KEYS)) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 300);
  }
  return Object.keys(out).length ? out : null;
}

export function requestNo(id: string): string {
  return id.replace(/-/g, '').slice(0, 8).toUpperCase();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function when(iso: string): string {
  const d = new Date(iso);
  const f = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  return `${f.format(d)} МСК`;
}

export function subjectOf(r: SupportRow): string {
  const first = r.body.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const short = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
  return `СКАМ · ${TOPICS[r.topic] ?? 'Обращение'}: ${short} [#${requestNo(r.id)}]`;
}

export function letterOf(r: SupportRow): { text: string; html: string } {
  const no = requestNo(r.id);
  const topic = TOPICS[r.topic] ?? r.topic;
  const who = [r.name || 'Без имени', r.username ? `@${r.username}` : null].filter(Boolean).join(' ');
  const meta = (r.meta ?? {}) as Record<string, string>;
  const metaRows = Object.keys(META_KEYS).filter((k) => typeof meta[k] === 'string').map((k) => [META_KEYS[k], meta[k]]);

  const text = [
    `Обращение в поддержку СКАМ #${no}`,
    `Тема: ${topic}`,
    '',
    `От: ${who}`,
    `Почта: ${r.email ?? 'не указана'}${r.email ? ' — чтобы ответить, нажмите «Ответить»' : ''}`,
    `ID пользователя: ${r.user_id}`,
    `Время: ${when(r.created_at)}`,
    '',
    '────────────────────────',
    r.body,
    '────────────────────────',
    ...(metaRows.length ? ['', 'Устройство:', ...metaRows.map(([k, v]) => `  ${k}: ${v}`)] : ['', 'Данные об устройстве не приложены.']),
    '',
  ].join('\n');

  const row = (k: string, v: string) =>
    `<tr><td style="padding:3px 12px 3px 0;color:#6E685E;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:3px 0">${v}</td></tr>`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:26px 24px;color:#0E0E10;background:#F4EFE6;border-radius:20px">
  <p style="margin:0 0 4px;font-size:13px;font-weight:bold;letter-spacing:2px;color:#B5400C">СКАМ · ПОДДЕРЖКА</p>
  <h2 style="margin:0 0 16px;font-size:21px">${esc(topic)} · #${no}</h2>
  <table style="border-collapse:collapse;font-size:14px;line-height:1.45;margin:0 0 16px">
    ${row('От', esc(who))}
    ${row('Почта', r.email ? `<a href="mailto:${esc(r.email)}" style="color:#B5400C">${esc(r.email)}</a>` : 'не указана')}
    ${row('ID', `<span style="font-family:'Courier New',monospace;font-size:12px">${esc(r.user_id)}</span>`)}
    ${row('Время', esc(when(r.created_at)))}
  </table>
  <div style="background:#FFFCF7;border:1px solid #DCD4C6;border-radius:14px;padding:14px 16px;font-size:15px;line-height:1.5;white-space:pre-wrap;word-wrap:break-word">${esc(r.body)}</div>
  ${r.email ? '<p style="margin:14px 0 0;font-size:13px;color:#6E685E">Чтобы ответить, просто нажмите «Ответить» — письмо уйдёт человеку на почту.</p>' : ''}
  ${metaRows.length
    ? `<hr style="border:0;border-top:1px solid #DCD4C6;margin:18px 0 12px"><table style="border-collapse:collapse;font-size:12.5px;line-height:1.4;color:#0E0E10">${metaRows.map(([k, v]) => row(k, esc(v))).join('')}</table>`
    : '<p style="margin:14px 0 0;font-size:12.5px;color:#6E685E">Данные об устройстве не приложены.</p>'}
</div>`;
  return { text, html };
}
