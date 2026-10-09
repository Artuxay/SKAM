// Свои эмодзи: наборы (как стикеры, kind = 'emoji'), вставка в текст и реакции.
//
// В поле ввода эмодзи выглядит как :название: — так же, как в Discord. При отправке :название: моих эмодзи
// превращается в метку <:название:набор/эмодзи>; в ленте метка рисуется картинкой. Чужая метка показывается
// у всех: картинка лежит в публичном бакете stickers по пути набор/эмодзи. Если картинки уже нет — видно :название:.
// В личных чатах и группах метка, как и весь текст, внутри шифротекста.
//
// Реакция своим эмодзи — ключ 'c:набор/эмодзи'.

import type { StickerPackInfo } from './database.types';
import { lsGet, lsSet } from './dom';
import { stickerUrl } from './stickers';

export type CustomEmoji = {
  /** набор/эмодзи — путь картинки и часть метки. */
  ref: string;
  pack: string;
  name: string;
  /** Что вставляется в поле ввода: имя, а при совпадении имён в разных наборах — имя~2, имя~3… */
  key: string;
};

export type EmojiPack = { id: string; title: string; mine: boolean; emojis: CustomEmoji[] };

export const EMOJI_REF_RE = /^u[0-9a-f]{11}\/[a-z0-9]{10}$/;
/** Название: буквы (латиница и кириллица), цифры и _, 2–32 символа. */
export const EMOJI_NAME_RE = /^[a-z0-9_а-яё]{2,32}$/;
/** Метка в тексте сообщения. */
export const TOKEN_RE = /<:([a-z0-9_а-яё]{2,32}):(u[0-9a-f]{11}\/[a-z0-9]{10})>/gu;
/** :название: в поле ввода (не внутри метки и не «12:30:45»). */
const SHORT_RE = /(?<![<\p{L}\p{N}_]):([\p{L}\p{N}_]{2,32}(?:~\d{1,2})?):/gu;

let packs: EmojiPack[] = [];
const byKey = new Map<string, CustomEmoji>();
const byRef = new Map<string, CustomEmoji>();

export function emojiPacks(): EmojiPack[] {
  return packs;
}

export function setEmojiPacks(list: StickerPackInfo[]): void {
  byKey.clear();
  byRef.clear();
  packs = list.map((p) => {
    const emojis: CustomEmoji[] = [];
    for (const x of p.stickers) {
      if (!x.name) continue;
      const ref = `${p.id}/${x.id}`;
      let key = x.name;
      for (let n = 2; byKey.has(key); n++) key = `${x.name}~${n}`;
      const e: CustomEmoji = { ref, pack: p.id, name: x.name, key };
      byKey.set(key, e);
      byRef.set(ref, e);
      emojis.push(e);
    }
    return { id: p.id, title: p.title, mine: p.mine, emojis };
  });
}

export function emojiByRef(ref: string): CustomEmoji | null {
  return byRef.get(ref) ?? null;
}

export function emojiUrl(ref: string): string {
  return stickerUrl(ref);
}

/** Название, как его сохранит сервер: без двоеточий и пробелов по краям, в нижнем регистре. */
export function normEmojiName(v: string): string {
  return v.trim().replace(/^:+|:+$/g, '').trim().toLowerCase();
}

/** Название из имени файла: «Cat Happy.png» → cat_happy. Пусто — если ничего не осталось. */
export function nameFromFile(file: string): string {
  const base = file.replace(/\.[a-z0-9]{2,5}$/i, '').toLowerCase().replace(/[\s.-]+/g, '_').replace(/[^a-z0-9_а-яё]/g, '');
  const t = base.replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 32);
  return t.length >= 2 ? t : '';
}

/** :название: моих эмодзи → метки для отправки. Незнакомые :слова: остаются как есть. */
export function encodeEmoji(text: string): string {
  if (!byKey.size || !text.includes(':')) return text;
  return text.replace(SHORT_RE, (all, key: string) => {
    const e = byKey.get(key.toLowerCase());
    return e ? `<:${e.name}:${e.ref}>` : all;
  });
}

/** Метки → :название: (для списка чатов, уведомлений, цитат, копирования). */
export function plainEmoji(text: string): string {
  if (!text || !text.includes('<:')) return text;
  return text.replace(TOKEN_RE, (_all, name: string) => `:${name}:`);
}

/** Текст сообщения → в поле ввода (правка поста): мои эмодзи — как :ключ:, чужие метки — как есть. */
export function emojiForInput(text: string): string {
  if (!text || !text.includes('<:')) return text;
  return text.replace(TOKEN_RE, (all, _name: string, ref: string) => {
    const e = byRef.get(ref);
    return e ? `:${e.key}:` : all;
  });
}

/** Сколько меток в тексте и есть ли что-то кроме них (для крупных эмодзи, как в Telegram). */
export function emojiOnly(text: string): number {
  if (!text || !text.includes('<:')) return 0;
  const n = (text.match(TOKEN_RE) ?? []).length;
  return n && !text.replace(TOKEN_RE, '').trim() ? n : 0;
}

// ---------------------------------------------------------------------------
// Реакции
// ---------------------------------------------------------------------------

export const STANDARD_REACTIONS = [
  { k: 'like', e: '👍' }, { k: 'lol', e: '😂' }, { k: 'fire', e: '🔥' }, { k: 'wow', e: '😱' }, { k: 'clown', e: '🤡' },
] as const;

export function customRef(key: string): string | null {
  if (!key.startsWith('c:')) return null;
  const ref = key.slice(2);
  return EMOJI_REF_RE.test(ref) ? ref : null;
}

/** Недавние свои эмодзи (в реакциях и в тексте) — только на этом устройстве. */
const RECENT_KEY = 'skam:emoji:recent';
export function recentEmoji(): string[] {
  try {
    const raw = JSON.parse(lsGet(RECENT_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string' && EMOJI_REF_RE.test(r)).slice(0, 16) : [];
  } catch {
    return [];
  }
}
export function rememberEmoji(ref: string): void {
  lsSet(RECENT_KEY, JSON.stringify([ref, ...recentEmoji().filter((r) => r !== ref)].slice(0, 16)));
}

// Обычные эмодзи для панели (на компьютере их неудобно набирать).
export const BASIC_EMOJI = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇', '🥰', '😍', '🤩', '😘',
  '😋', '😛', '😜', '🤪', '🤗', '🤭', '🤫', '🤔', '🤨', '😐', '😑', '😶', '😏', '😒', '🙄', '😬',
  '😌', '😔', '😪', '😴', '😷', '🤒', '🥵', '🥶', '🥴', '😵', '🤯', '🥳', '😎', '🤓', '🧐', '😕',
  '😟', '🙁', '😮', '😯', '😲', '😳', '🥺', '😦', '😧', '😨', '😰', '😥', '😢', '😭', '😱', '😖',
  '😣', '😞', '😓', '😩', '😫', '🥱', '😤', '😡', '😠', '🤬', '😈', '💀', '💩', '🤡', '👻', '👽',
  '👍', '👎', '👌', '✌️', '🤞', '🤟', '🤘', '👋', '👏', '🙌', '🙏', '🤝', '💪', '👀', '🧠', '🫶',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '💯', '💥', '🔥', '✨', '⭐', '🎉', '🎁',
  '🕊️', '🐈', '🐶', '🦊', '🐸', '🐵', '🍕', '🍔', '🍟', '☕', '🍺', '🎮', '⚽', '🚀', '✅', '❌',
];
