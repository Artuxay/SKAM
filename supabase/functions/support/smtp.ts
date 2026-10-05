// Маленький SMTP-клиент без сторонних библиотек: TLS сразу (порт 1127 Selectel или 465),
// AUTH PLAIN/LOGIN, письмо в UTF-8 (multipart/alternative: текст + HTML).
// Selectel: smtp.mail.selcloud.ru:1127, логин и пароль — из карточки почтового ресурса;
// Яндекс: smtp.yandex.ru:465, логин — адрес ящика, пароль — «пароль приложения».

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Общий срок на сеанс, мс. */
  timeoutMs?: number;
  /** Для тестов: своё подключение вместо Deno.connectTls. */
  connect?: () => Promise<Deno.Conn>;
};

export type Mail = {
  from: string;
  fromName?: string;
  to: string;
  replyTo?: string | null;
  replyToName?: string | null;
  subject: string;
  text: string;
  html?: string;
  messageId?: string;
};

export class SmtpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------------------------------------------------------------------------
// Кодирование письма
// ---------------------------------------------------------------------------

export function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const ADDR_RE = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+\.[^\s<>()[\]\\,;:"@]+$/;
export function validAddress(a: string | null | undefined): a is string {
  return typeof a === 'string' && a.length <= 254 && ADDR_RE.test(a);
}

/** Заголовок с не-ASCII текстом → =?UTF-8?B?…?= кусками не длиннее 75 символов (RFC 2047). */
export function encodeHeader(value: string): string {
  const clean = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean) && clean.length <= 900) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    // 45 байт UTF-8 → 60 символов base64 → слово из 72 символов.
    if (enc.encode(chunk + ch).length > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${b64(enc.encode(w))}?=`).join('\r\n ');
}

export function formatAddress(addr: string, name?: string | null): string {
  if (!name) return `<${addr}>`;
  const n = name.replace(/[\r\n\t]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(n)) return `"${n.replace(/["\\]/g, '')}" <${addr}>`;
  return `${encodeHeader(n)} <${addr}>`;
}

function wrap76(s: string): string {
  return s.replace(/.{1,76}/g, '$&\r\n');
}

function part(type: string, body: string): string {
  return `Content-Type: ${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(enc.encode(body)))}`;
}

export function buildMessage(m: Mail, date = new Date()): string {
  const boundary = `skam-${crypto.randomUUID()}`;
  const head = [
    `From: ${formatAddress(m.from, m.fromName)}`,
    `To: <${m.to}>`,
    ...(validAddress(m.replyTo) ? [`Reply-To: ${formatAddress(m.replyTo, m.replyToName)}`] : []),
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId ?? `<${crypto.randomUUID()}@${m.from.split('@')[1]}>`}`,
    'MIME-Version: 1.0',
  ];
  if (!m.html) return `${head.join('\r\n')}\r\n${part('text/plain', m.text)}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    part('text/plain', m.text),
    `--${boundary}`,
    part('text/html', m.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Точка в начале строки удваивается, окончания строк — CRLF. */
export function dotStuff(msg: string): string {
  return msg.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

// ---------------------------------------------------------------------------
// Сеанс SMTP
// ---------------------------------------------------------------------------

export class SmtpSession {
  private buf = '';
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private timer: ReturnType<typeof setTimeout>;
  private closed = false;

  private constructor(private conn: Deno.Conn, timeoutMs: number) {
    this.reader = conn.readable.getReader();
    this.writer = conn.writable.getWriter();
    this.timer = setTimeout(() => this.close(), timeoutMs);
  }

  static async open(cfg: SmtpConfig): Promise<SmtpSession> {
    const conn = cfg.connect ? await cfg.connect() : await Deno.connectTls({ hostname: cfg.host, port: cfg.port });
    const s = new SmtpSession(conn, cfg.timeoutMs ?? 20_000);
    try {
      await s.expect(220);
      const ehlo = await s.cmd('EHLO skam.messenger', 250);
      const auth = ehlo.find((l) => /^AUTH[ =]/i.test(l))?.toUpperCase() ?? '';
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await s.cmd(`AUTH PLAIN ${b64(enc.encode(`\0${cfg.user}\0${cfg.pass}`))}`, 235, true);
      } else {
        await s.cmd('AUTH LOGIN', 334);
        await s.cmd(b64(enc.encode(cfg.user)), 334);
        await s.cmd(b64(enc.encode(cfg.pass)), 235, true);
      }
      return s;
    } catch (e) {
      s.close();
      throw e;
    }
  }

  async send(m: Mail): Promise<void> {
    if (!validAddress(m.from) || !validAddress(m.to)) throw new SmtpError(0, 'Неверный адрес отправителя или получателя');
    try {
      await this.cmd(`MAIL FROM:<${m.from}>`, 250);
      await this.cmd(`RCPT TO:<${m.to}>`, [250, 251]);
      await this.cmd('DATA', 354);
      await this.cmd(`${dotStuff(buildMessage(m))}\r\n.`, 250);
    } catch (e) {
      // Сбрасываем незавершённое письмо, чтобы сеанс можно было использовать дальше.
      if (!this.closed) await this.cmd('RSET', 250).catch(() => {});
      throw e;
    }
  }

  async quit(): Promise<void> {
    if (this.closed) return;
    await this.cmd('QUIT', 221).catch(() => {});
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    try { this.conn.close(); } catch { /* уже закрыто */ }
  }

  private async write(line: string): Promise<void> {
    if (this.closed) throw new SmtpError(0, 'SMTP: соединение закрыто (таймаут?)');
    await this.writer.write(enc.encode(`${line}\r\n`));
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf('\r\n');
      if (i >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        return line;
      }
      if (this.closed) throw new SmtpError(0, 'SMTP: соединение закрыто (таймаут?)');
      const { value, done } = await this.reader.read().catch((e: unknown) => {
        if (this.closed) throw new SmtpError(0, 'SMTP: сервер не ответил вовремя');
        throw new SmtpError(0, `SMTP: ${e instanceof Error ? e.message : String(e)}`);
      });
      if (done || !value) throw new SmtpError(0, this.closed ? 'SMTP: сервер не ответил вовремя' : 'SMTP: сервер закрыл соединение');
      this.buf += dec.decode(value, { stream: true });
    }
  }

  /** Ответ сервера: «250-…» — продолжение, «250 …» — последняя строка. */
  private async reply(): Promise<{ code: number; lines: string[] }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line.slice(4));
      if (line.length < 4 || line[3] !== '-') return { code: Number(line.slice(0, 3)) || 0, lines };
    }
  }

  private async expect(ok: number | number[], secret = false): Promise<string[]> {
    const { code, lines } = await this.reply();
    const want = Array.isArray(ok) ? ok : [ok];
    if (!want.includes(code)) {
      const text = lines.join(' ').slice(0, 300);
      throw new SmtpError(code, `SMTP ${code}${secret ? ' (вход)' : ''}: ${text}`);
    }
    return lines;
  }

  private async cmd(line: string, ok: number | number[], secret = false): Promise<string[]> {
    await this.write(line);
    return this.expect(ok, secret);
  }
}
