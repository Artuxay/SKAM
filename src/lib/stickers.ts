// Стикеры. Официальный набор — «Голубь свободы», маскот СКАМ.
// Картинки лежат в public/stickers/<набор>/<стикер>.webp (256×256, прозрачный фон) и приезжают вместе с приложением.
// Неофициальные наборы делают сами пользователи: картинки — в Supabase Storage (бакет stickers,
// путь u<11 hex>/<10 символов>), список — RPC my_sticker_packs. Особых меток у них нет.
// В сообщении хранится ссылка «набор/стикер» (messages.sticker) и эмодзи стикера (messages.body).

import type { StickerPackInfo } from './database.types';
import { lsGet, lsSet } from './dom';
import { sb } from './supabase';

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

export type StickerPack = {
  id: string; title: string; official: boolean; stickers: Sticker[];
  /** Неофициальный набор, который сделал я. */
  mine?: boolean;
};

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

/** Неофициальный набор: u + 11 hex; стикер в нём — 10 символов. */
export const CUSTOM_PACK_RE = /^u[0-9a-f]{11}$/;
const CUSTOM_REF_RE = /^u[0-9a-f]{11}\/[a-z0-9]{10}$/;

export function isCustomRef(ref: string | null | undefined): boolean {
  return !!ref && CUSTOM_REF_RE.test(ref);
}

/** Мои неофициальные наборы (созданные и добавленные) — в панели после официальных. */
let custom: StickerPack[] = [];
let BY_REF = new Map<string, Sticker>();
const BY_EMOJI = new Map<string, Sticker[]>();

export function customPacks(): StickerPack[] {
  return custom;
}

export function allPacks(): StickerPack[] {
  return [...PACKS, ...custom];
}

export function packFromInfo(info: StickerPackInfo): StickerPack {
  return {
    id: info.id,
    title: info.title,
    official: false,
    mine: info.mine,
    stickers: info.stickers.map((x) => ({ ref: `${info.id}/${x.id}`, pack: info.id, label: info.title, emoji: x.emoji ?? '', emojis: x.emoji ? [x.emoji] : [] })),
  };
}

export function setCustomPacks(list: StickerPackInfo[]): void {
  custom = list.filter((p) => CUSTOM_PACK_RE.test(p.id) && p.kind !== 'emoji').map(packFromInfo);
  reindex();
}

function reindex(): void {
  BY_REF = new Map<string, Sticker>(allPacks().flatMap((p) => p.stickers.map((s) => [s.ref, s] as const)));
  BY_EMOJI.clear();
  for (const s of BY_REF.values()) {
    for (const e of s.emojis) {
      const k = normEmoji(e);
      if (k) BY_EMOJI.set(k, [...(BY_EMOJI.get(k) ?? []), s]);
    }
  }
}

/** Стикер из официального набора или из моих наборов. */
export function knownSticker(ref: string | null | undefined): Sticker | null {
  return (ref && BY_REF.get(ref)) || null;
}

/** Стикер для показа: чужой неофициальный тоже показываем — картинка по ссылке, эмодзи из сообщения. */
export function findSticker(ref: string | null | undefined, emoji?: string | null): Sticker | null {
  const known = knownSticker(ref);
  if (known) return known;
  if (!ref || !isCustomRef(ref)) return null;
  const e = (emoji ?? '').trim();
  return { ref, pack: ref.split('/')[0], label: 'Стикер', emoji: e, emojis: e ? [e] : [] };
}

export function stickerUrl(ref: string): string {
  if (isCustomRef(ref)) return sb.storage.from('stickers').getPublicUrl(ref).data.publicUrl;
  const [pack, id] = ref.split('/');
  return `${import.meta.env.BASE_URL}stickers/${pack}/${id}.webp`;
}

export function packOf(id: string): StickerPack | null {
  return allPacks().find((p) => p.id === id) ?? null;
}

/** Вариационный селектор (U+FE0F) и пробелы не важны: «❤» и «❤️» — одно и то же. */
function normEmoji(s: string): string {
  return s.replace(/[︎️\s]/g, '');
}

reindex();

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
    return raw.map((r) => knownSticker(typeof r === 'string' ? r : null)).filter((s): s is Sticker => !!s);
  } catch {
    return [];
  }
}

export function rememberSticker(ref: string): void {
  const list = [ref, ...recentStickers().map((s) => s.ref).filter((r) => r !== ref)].slice(0, RECENT_MAX);
  lsSet(RECENT_KEY, JSON.stringify(list));
}
