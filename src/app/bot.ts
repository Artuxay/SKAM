// Бот СКАМ с нейросетью (0.4.2): доступна ли она мне и включил ли я её (сообщения нейросети уходят
// в Google, поэтому только с согласия), «печатает…» в шапке, пока ждём ответ, переключатель и
// «Новый диалог». Сама нейросеть работает на сервере (Edge Function bot-ai), здесь — только вид.

import { sb } from '../lib/supabase';
import type { BotAiStatus, MyChat } from '../lib/database.types';
import { S, emit, meId, type Msg } from './store';

/** Ответ нейросети ждём не дольше двух минут — дальше «печатает…» гаснет. */
const WAIT_MS = 120_000;
/** «Да» на предложение нейросети: бот включил её и уже ищет ответ на прежний вопрос. */
const ANSWERING = 'Отвечаю на ваш вопрос…';
// Команды, на которые бот отвечает сразу, без нейросети (как private.bot_ai_command на сервере).
const INSTANT = [
  /^\/start$/,
  /^(\/new|\/reset|новый диалог|новый разговор|начать заново|начн[её]м заново|забудь вс[её]|сброс)[.!]*$/,
  /^(\/help|помощь|помоги|help|команды|что (ты )?умеешь)[.!?]*$/,
  /^(\/ai|\/ai_on|включи(ть)? нейросеть|включи(ть)? ии)[.!]*$/,
  /^(\/ai_off|выключи(ть)? нейросеть|отключи(ть)? нейросеть|выключи(ть)? ии|отключи(ть)? ии)[.!]*$/,
  /^https?:\/\/(www\.|test\.)?skam-messenger\.ru\/a\/[a-z0-9-]+\/?$/,
];

let status: BotAiStatus | null = null;
let loadedAt = 0;
let loading: Promise<BotAiStatus | null> | null = null;
let recheck: number | undefined;

export function botAi(): BotAiStatus | null {
  return status;
}

/** Статус нейросети (кэш на минуту). Старый сервер без функции — нейросети просто нет. */
export function loadBotAi(force = false): Promise<BotAiStatus | null> {
  if (!force && Date.now() - loadedAt < 60_000) return Promise.resolve(status);
  if (loading) return loading;
  loading = (async () => {
    const { data, error } = await sb.rpc('bot_ai_status');
    loadedAt = Date.now();
    const next = error ? status : data ?? null;
    const changed = JSON.stringify(next) !== JSON.stringify(status);
    status = next;
    if (changed) emit('head');
    return status;
  })().finally(() => { loading = null; });
  return loading;
}

/**
 * «печатает…» в шапке чата с ботом: нейросеть включена, а последнее сообщение в чате — мой вопрос,
 * отправленный меньше двух минут назад (на команды и стикеры бот отвечает сразу).
 */
export function botTyping(c: MyChat): boolean {
  if (c.kind !== 'bot' || !status?.enabled) return false;
  const msgs: Msg[] = S.feeds.get(c.id)?.msgs ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.deleted_at) continue;
    const answering = !m.user_id && m.kind === 'system' && m.body.startsWith('✅') && m.body.includes(ANSWERING);
    if (!answering) {
      if (!status.agreed || m.user_id !== meId() || m.kind !== 'text' || m.failed) return false;
      const t = m.body.trim().toLowerCase();
      if (INSTANT.some((re) => re.test(t))) return false;
    }
    const left = Date.parse(m.created_at) + WAIT_MS - Date.now();
    if (left <= 0) return false;
    // Когда ждать надоест — шапку надо перерисовать без новых событий.
    clearTimeout(recheck);
    recheck = window.setTimeout(() => emit('head'), Math.min(left + 50, WAIT_MS));
    return true;
  }
  return false;
}

/**
 * Отправили боту сообщение. Вопрос нейросети сразу считаем в лимит (сервер всё равно поправит);
 * команда или «да» на предложение могли включить или выключить нейросеть — статус перечитываем.
 */
export function noteBotQuestion(c: MyChat | null | undefined, text: string): void {
  if (c?.kind !== 'bot' || !status?.enabled) return;
  const t = text.trim().toLowerCase();
  if (status.agreed && t && !INSTANT.some((re) => re.test(t))) {
    status = { ...status, used: status.used + 1 };
    loadedAt = 0;
    return;
  }
  setTimeout(() => void loadBotAi(true), 1500);
}

/** Включить или выключить нейросеть в чате с ботом; ответ бота придёт в чат. */
export async function setBotAi(on: boolean): Promise<void> {
  const before = status;
  if (status) status = { ...status, agreed: on };
  emit('head');
  const { error } = await sb.rpc('bot_ai_agree', { p_on: on });
  if (error) {
    status = before;
    emit('head');
    throw error;
  }
  loadedAt = 0;
}

/** «Новый диалог»: нейросеть забудет прошлую переписку, в чате появится отметка. */
export async function resetBotDialog(): Promise<void> {
  const { error } = await sb.rpc('bot_ai_reset');
  if (error) throw error;
}

export function resetBot(): void {
  status = null;
  loadedAt = 0;
  clearTimeout(recheck);
}
