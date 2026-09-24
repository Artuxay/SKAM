// Стикеры. Официальный набор — «Голубь свободы», маскот СКАМ.
// Картинки лежат в public/stickers/<набор>/<стикер>.webp (256×256, прозрачный фон) и приезжают вместе с приложением.
// В сообщении хранится ссылка «набор/стикер» (messages.sticker) и эмодзи стикера (messages.body).

import { lsGet, lsSet } from './dom';

export type Sticker = {
  /** «набор/стикер», например dove/hi — то, что уходит в messages.sticker. */
  ref: string;
  pack: string;
  /** Подпись на стикере — для alt и подсказок. */
  label: string;
  /** Главный эмодзи (уходит в messages.body и видна в списке чатов). */
  emoji: string;
  /** Все эмодзи, по которым стикер предлагается при наборе. */
  emojis: string[];
};

export type StickerPack = { id: string; title: string; official: boolean; stickers: Sticker[] };

// Порядок — как на листе стикеров.
const DOVE: [id: string, label: string, emojis: string[]][] = [
  ['hi', 'Привет!', ['👋', '🙋', '🤗']],
  ['yes', 'Да', ['👍', '✅', '☑️']],
  ['no', 'Нет', ['🙅', '👎', '❌', '🚫']],
  ['haha', 'Ха-ха-ха', ['😂', '🤣', '😆', '😅']],
  ['love', 'Люблю', ['😍', '❤️', '🥰', '💕', '😘']],
  ['what', 'Что?!', ['😳', '😲', '😮', '❓', '⁉️']],
  ['wait', 'Жду', ['⏳', '😒', '🙄', '⌛']],
  ['night', 'Спокойной ночи', ['😴', '🌙', '💤', '🛌']],
  ['sad', 'Грусть', ['😢', '😭', '😔', '😞']],
  ['angry', 'Бесишь!', ['😠', '😡', '🤬', '💢']],
  ['hmm', 'Хм…', ['🤔', '🧐', '🤨']],
  ['freedom', 'Свобода!', ['🕊️', '🎉', '🥳', '🙌']],
  ['legit', 'Не развод', ['🤞', '💯', '😇']],
  ['thanks', 'Спасибо', ['🙏', '🤝', '💐']],
  ['morning', 'Доброе утро', ['☕', '🌅', '☀️', '🌞']],
  ['ok', 'OK', ['👌', '🆗', '✨', '👏']],
];

export const PACKS: StickerPack[] = [
  {
    id: 'dove',
    title: 'Голубь свободы',
    official: true,
    stickers: DOVE.map(([id, label, emojis]) => ({ ref: `dove/${id}`, pack: 'dove', label, emoji: emojis[0], emojis })),
  },
];

const BY_REF = new Map<string, Sticker>(PACKS.flatMap((p) => p.stickers.map((s) => [s.ref, s] as const)));

export function findSticker(ref: string | null | undefined): Sticker | null {
  return (ref && BY_REF.get(ref)) || null;
}

export function stickerUrl(ref: string): string {
  const [pack, id] = ref.split('/');
  return `${import.meta.env.BASE_URL}stickers/${pack}/${id}.webp`;
}

export function packOf(id: string): StickerPack | null {
  return PACKS.find((p) => p.id === id) ?? null;
}

/** Вариационный селектор (U+FE0F) и пробелы не важны: «❤» и «❤️» — одно и то же. */
function normEmoji(s: string): string {
  return s.replace(/[︎️\s]/g, '');
}

const BY_EMOJI = new Map<string, Sticker[]>();
for (const s of BY_REF.values()) {
  for (const e of s.emojis) {
    const k = normEmoji(e);
    BY_EMOJI.set(k, [...(BY_EMOJI.get(k) ?? []), s]);
  }
}

/** Стикеры к эмодзи, которое человек набрал в поле ввода (как подсказки в Telegram). */
export function stickersForEmoji(text: string): Sticker[] {
  const k = normEmoji(text);
  return k ? BY_EMOJI.get(k) ?? [] : [];
}

// Недавние — только на этом устройстве.
const RECENT_KEY = 'skam:stickers:recent';
const RECENT_MAX = 12;

export function recentStickers(): Sticker[] {
  try {
    const raw = JSON.parse(lsGet(RECENT_KEY) ?? '[]') as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => findSticker(typeof r === 'string' ? r : null)).filter((s): s is Sticker => !!s);
  } catch {
    return [];
  }
}

export function rememberSticker(ref: string): void {
  const list = [ref, ...recentStickers().map((s) => s.ref).filter((r) => r !== ref)].slice(0, RECENT_MAX);
  lsSet(RECENT_KEY, JSON.stringify(list));
}
