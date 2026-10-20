// Типы схемы из supabase/migrations.
// Формат совместим с `supabase gen types typescript` — при желании файл можно перегенерировать:
//   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** saved — «Избранное»: личный чат с самим собой (с 0.3.6). */
export type ChatKind = 'group' | 'direct' | 'channel' | 'bot' | 'saved';

/** Неофициальный набор стикеров или своих эмодзи: картинки — storage stickers/<id>/<стикер>. */
export type StickerPackInfo = {
  id: string;
  title: string;
  /** sticker — стикеры (у каждого эмодзи), emoji — свои эмодзи (у каждого название). Старые ответы — без kind. */
  kind?: 'sticker' | 'emoji';
  /** Мой набор (я его автор). */
  mine: boolean;
  /** Набор добавлен в мою панель стикеров. */
  added: boolean;
  /** У стикера — emoji, у своего эмодзи — name (:кот:). */
  stickers: { id: string; emoji?: string; name?: string }[];
};

/** Можно ли мне супер-реакцию в группе или канале (super_reaction_status). */
export type SuperStatus = {
  available: boolean;
  eligible: boolean;
  score: number;
  need: number;
  member_days: number;
  need_days: number;
  active_days: number;
  per_day: number;
  left: number;
};


/** Вложение: файл лежит в бакете media зашифрованным своим ключом (key, base64, 32 байта). */
export type Attachment = {
  id: string;
  kind: 'photo' | 'video' | 'file';
  name: string;
  mime: string;
  /** Размер исходного файла в байтах. */
  size: number;
  /** media/<чат>/<автор>/<uuid>.bin */
  path: string;
  key: string;
  w?: number;
  h?: number;
  /** Длительность видео, секунды. */
  dur?: number;
  /** Крошечное размытое превью (data:image/jpeg), показывается, пока грузится картинка. */
  mini?: string;
  /** Уменьшенная копия (до 720 px) — для ленты; зашифрована тем же ключом. */
  thumb?: { path: string; w: number; h: number };
};

/** «Переслано от …»: имя автора оригинала, его id (если это человек) и время оригинала. */
export type Forward = { name: string; from?: string; kind?: 'user' | 'channel' | 'bot'; at?: string };

/** Роль в чате: владелец, администратор (с правами) и участник/подписчик. */
export type ChatRole = 'owner' | 'admin' | 'member';
/**
 * Права администратора (как в Telegram). В канале — все семь, в группе — без post и edit.
 * info — профиль (название, фото, описание, ссылка); post — публикация; edit — изменение чужих публикаций;
 * delete — удаление чужих сообщений; invite — добавление участников и ссылка-приглашение;
 * ban — удаление и блокировка; admins — назначение администраторов.
 */
export type ChatRight = 'info' | 'post' | 'edit' | 'delete' | 'invite' | 'ban' | 'admins';

/** Карточка группы или канала (по ссылке, в поиске). */
export type ChatCard = {
  id: string; kind: ChatKind; name: string; emoji: string; avatar_path: string | null; description: string | null;
  username: string | null; member_count: number; is_member: boolean;
  /** Официальная галочка канала. */
  verified: boolean;
};

/** Участник с профилем (список участников, подписчики, администраторы). */
export type MemberInfo = {
  user_id: string; role: ChatRole; rights: ChatRight[] | null; promoted_by: string | null; joined_at: string;
  name: string | null; username: string | null; avatar_path: string | null; color: string;
  /** Время захода — только если оба разрешают друг другу (0.4.1), иначе null и примерное seen. */
  last_seen_at: string | null; online_until: string | null; seen: SeenBucket | null; verified: boolean;
};

/** Примерное время захода, когда точное скрыто: недавно / на этой неделе / в этом месяце / давно. */
export type SeenBucket = 'recently' | 'week' | 'month' | 'long';

/** Что я вижу о времени захода человека (user_presence): точное время или только seen. */
export type Presence = { online_until: string | null; last_seen_at: string | null; seen: SeenBucket | null };

/** Кто видит моё время захода (0.4.1). */
export type LastSeenPrivacy = 'everybody' | 'contacts' | 'nobody';

/** Личный канал человека в профиле — с последним постом. */
export type PersonalChannel = {
  id: string; name: string | null; username: string; avatar_path: string | null; verified: boolean;
  member_count: number; is_member: boolean;
  post_id: string | null; post_kind: string | null; post_body: string | null; post_at: string | null;
  post_media_mime: string | null; post_files: unknown[] | null; post_sticker: string | null;
};

export type CallStatus = 'active' | 'ended' | 'missed' | 'declined' | 'cancelled';

type CallRow = {
  id: string;
  chat_id: string;
  started_by: string | null;
  video: boolean;
  created_at: string;
  rung_at: string;
  answered_at: string | null;
  ended_at: string | null;
  status: CallStatus;
};

export type CallMemberInfo = {
  user_id: string;
  state: 'in' | 'left' | 'declined';
  device: string | null;
  joined_at: string | null;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
};

type ChatRow = {
  id: string;
  kind: ChatKind;
  name: string | null;
  emoji: string;
  created_by: string | null;
  invite_code: string | null;
  direct_key: string | null;
  is_default: boolean;
  created_at: string;
  description: string | null;
  /** Публичный канал: @имя и ссылка ?c=имя. */
  username: string | null;
  /** Фото группы или канала: avatars/chat/<id>/<файл>. */
  avatar_path: string | null;
  /** Подписывать посты канала именем автора. */
  sign_messages: boolean;
  /** Официальная галочка (только у каналов; выдаёт владелец СКАМ). */
  verified: boolean;
  /** Комментарии к постам канала включены (0.5.1). */
  comments?: boolean;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          /** Вычисляется из имени и фамилии. */
          name: string | null;
          first_name: string | null;
          last_name: string | null;
          username: string | null;
          /** Исключение: этому аккаунту @username необязателен (ставит администратор). */
          username_optional: boolean;
          /** Официальная галочка: выдаёт и снимает только владелец СКАМ (set_verified). */
          verified: boolean;
          /** «О себе»: до 140 символов, до 5 строк. Видят все (без общего чата — через user_bio). */
          bio: string | null;
          avatar_path: string | null;
          color: string;
          created_at: string;
          updated_at: string;
          /** Эмодзи-статус у имени (0.5.1): обычное эмодзи или c:набор/эмодзи. Ставится через set_emoji_status. */
          emoji_status?: string | null;
          /** До какого момента показывать статус; null — навсегда. */
          emoji_status_until?: string | null;
        };
        Insert: never;
        Update: {
          first_name?: string | null;
          last_name?: string | null;
          username?: string | null;
          avatar_path?: string | null;
          bio?: string | null;
        };
        Relationships: [];
      };
      chats: {
        Row: ChatRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      chat_members: {
        Row: {
          chat_id: string;
          user_id: string;
          role: ChatRole;
          joined_at: string;
          last_read_at: string;
          rights: ChatRight[] | null;
          promoted_by: string | null;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      messages: {
        Row: {
          id: string;
          chat_id: string;
          user_id: string | null;
          kind: MessageKind;
          /** Текст; у стикера — его эмодзи; у голосового, кружочка и зашифрованного — пусто. */
          body: string;
          created_at: string;
          deleted_at: string | null;
          /** Стикер: «набор/стикер», например dove/hi. */
          sticker: string | null;
          /** Голосовое или кружочек: путь в приватном бакете media — <чат>/<автор>/<uuid>.<расширение>. */
          media_path: string | null;
          media_mime: string | null;
          duration_ms: number | null;
          /** Громкость голосового: до 100 значений 0–100. */
          waveform: number[] | null;
          /** Шифротекст (base64) для kind = 'e2e'. */
          enc: string | null;
          /** Ключ чата, которым зашифровано сообщение. */
          key_id: string | null;
          /** Вложения для kind = 'media'. */
          files: Attachment[] | null;
          /** Ответ на сообщение (только в чатах без E2E; в зашифрованных — внутри enc). */
          reply_to: string | null;
          /** «Переслано от …» (только в чатах без E2E). */
          fwd: Forward | null;
          /** Запись о звонке (kind = 'call'). */
          call_id: string | null;
          /** Пост канала изменён. */
          edited_at: string | null;
          /** Подпись автора поста (снимок имени, если в канале включены подписи). */
          signature: string | null;
          /** Комментарий к посту канала (0.5.1): id поста. У постов и обычных сообщений — null. */
          thread_id?: string | null;
        };
        Insert: {
          id?: string;
          chat_id: string;
          body: string;
          kind?: 'text' | 'sticker' | 'voice' | 'video_note' | 'e2e' | 'media';
          sticker?: string | null;
          media_path?: string | null;
          media_mime?: string | null;
          duration_ms?: number | null;
          waveform?: number[] | null;
          enc?: string | null;
          key_id?: string | null;
          files?: Attachment[] | null;
          reply_to?: string | null;
          fwd?: Forward | null;
          thread_id?: string | null;
        };
        Update: never;
        Relationships: [];
      };
      calls: {
        Row: CallRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      call_members: {
        Row: {
          call_id: string;
          user_id: string;
          chat_id: string;
          state: 'in' | 'left' | 'declined';
          device: string | null;
          joined_at: string | null;
          left_at: string | null;
          seen_at: string;
          muted: boolean;
          deafened: boolean;
          camera: boolean;
          screen: boolean;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      call_signals: {
        Row: {
          id: number;
          call_id: string;
          from_user: string;
          to_user: string;
          payload: string;
          created_at: string;
        };
        Insert: { call_id: string; to_user: string; payload: string };
        Update: never;
        Relationships: [];
      };
      user_keys: {
        Row: {
          user_id: string;
          public_key: string;
          reset_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
      chat_keys: {
        Row: {
          id: string;
          chat_id: string;
          created_by: string | null;
          created_at: string;
        };
        Insert: { id: string; chat_id: string };
        Update: never;
        Relationships: [];
      };
      chat_key_shares: {
        Row: {
          key_id: string;
          user_id: string;
          sender_id: string;
          chat_id: string;
          sender_pub: string;
          wrapped: string;
          created_at: string;
        };
        Insert: { key_id: string; user_id: string; sender_pub: string; wrapped: string };
        Update: never;
        Relationships: [];
      };
      reactions: {
        Row: {
          message_id: string;
          user_id: string;
          emoji: ReactionKey;
          chat_id: string;
          created_at: string;
          /** Супер-реакция (выделяется цветом). */
          super?: boolean;
        };
        Insert: {
          message_id: string;
          emoji: ReactionKey;
        };
        Update: never;
        Relationships: [];
      };
      /** Опрос (0.4.0): числа голосов видят участники чата — по ним Realtime сообщает об изменениях. */
      polls: {
        Row: {
          message_id: string;
          chat_id: string;
          author_id: string | null;
          options: string[] | null;
          n: number;
          multiple: boolean;
          anonymous: boolean;
          quiz: boolean;
          counts: number[];
          voters: number;
          closed_at: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      my_chats: {
        Args: Record<PropertyKey, never>;
        Returns: {
          id: string;
          kind: ChatKind;
          name: string | null;
          emoji: string;
          invite_code: string | null;
          is_default: boolean;
          created_at: string;
          role: ChatRole;
          last_read_at: string;
          member_count: number;
          peer_id: string | null;
          unread: number;
          last_id: string | null;
          last_body: string | null;
          last_user_id: string | null;
          last_kind: MessageKind | null;
          last_at: string | null;
          last_deleted: boolean | null;
          last_enc: string | null;
          last_key_id: string | null;
          last_files: Attachment[] | null;
          /** Итог звонка, если последнее сообщение — запись о звонке. */
          last_call: { status: CallStatus; video: boolean; dur: number | null } | null;
          description: string | null;
          username: string | null;
          avatar_path: string | null;
          sign_messages: boolean;
          /** Мои права в этом чате (у владельца — все). */
          rights: ChatRight[];
          /** Официальная галочка: у канала — от владельца СКАМ, у бота СКАМ — всегда. */
          verified: boolean;
          /** Комментарии к постам канала включены (0.5.1). */
          comments?: boolean;
        }[];
      };
      create_chat: {
        Args: { p_name: string; p_emoji?: string | null; p_kind?: 'group' | 'channel'; p_description?: string | null };
        Returns: ChatRow;
      };
      update_chat: {
        Args: { p_chat: string; p_name?: string | null; p_emoji?: string | null; p_description?: string | null; p_sign?: boolean | null };
        Returns: undefined;
      };
      set_chat_avatar: { Args: { p_chat: string; p_path: string | null }; Returns: string | null };
      set_chat_username: { Args: { p_chat: string; p_username: string | null }; Returns: undefined };
      chat_username_available: { Args: { p_chat: string | null; p_username: string }; Returns: boolean };
      delete_chat: { Args: { p_chat: string }; Returns: undefined };
      add_chat_members: { Args: { p_chat: string; p_users: string[] }; Returns: number };
      remove_chat_member: { Args: { p_chat: string; p_user: string; p_ban?: boolean }; Returns: undefined };
      unban_chat_member: { Args: { p_chat: string; p_user: string }; Returns: undefined };
      chat_banned: {
        Args: { p_chat: string };
        Returns: {
          user_id: string; name: string | null; username: string | null; avatar_path: string | null; color: string;
          banned_by: string | null; banned_by_name: string | null; created_at: string;
        }[];
      };
      set_chat_admin: { Args: { p_chat: string; p_user: string; p_rights: ChatRight[] }; Returns: undefined };
      remove_chat_admin: { Args: { p_chat: string; p_user: string }; Returns: undefined };
      transfer_chat_owner: { Args: { p_chat: string; p_user: string }; Returns: undefined };
      chat_member_list: {
        Args: { p_chat: string; p_query?: string | null; p_admins?: boolean; p_limit?: number; p_offset?: number };
        Returns: MemberInfo[];
      };
      my_contacts: {
        Args: { p_chat?: string | null; p_limit?: number };
        Returns: {
          id: string; name: string | null; username: string | null; avatar_path: string | null; color: string;
          last_seen_at: string | null; online_until: string | null; seen: SeenBucket | null; in_chat: boolean; verified: boolean;
        }[];
      };
      user_presence: {
        Args: { p_ids: string[] };
        Returns: ({ user_id: string } & Presence)[];
      };
      my_privacy: { Args: Record<PropertyKey, never>; Returns: { last_seen: LastSeenPrivacy } | null };
      /** Мой предел размера файла в байтах; null — без предела (только потолок хранилища). */
      my_upload_limit: { Args: Record<PropertyKey, never>; Returns: number | null };
      bot_ai_status: { Args: Record<PropertyKey, never>; Returns: BotAiStatus | null };
      bot_ai_reset: { Args: Record<PropertyKey, never>; Returns: boolean };
      bot_ai_agree: { Args: { p_on: boolean }; Returns: boolean };
      set_privacy: { Args: { p_key: 'last_seen'; p_value: LastSeenPrivacy }; Returns: { last_seen: LastSeenPrivacy } };
      set_personal_channel: { Args: { p_chat: string | null }; Returns: undefined };
      personal_channel: { Args: { p_user: string }; Returns: PersonalChannel[] };
      my_oauth_links: { Args: Record<PropertyKey, never>; Returns: { provider: string; created_at: string; last_login_at: string }[] };
      oauth_unlink: { Args: { p_provider: string }; Returns: undefined };
      chat_by_invite: { Args: { p_code: string }; Returns: ChatCard[] };
      chat_by_username: { Args: { p_username: string }; Returns: ChatCard[] };
      search_chats: { Args: { p_query: string; p_limit?: number }; Returns: ChatCard[] };
      join_channel: { Args: { p_chat: string }; Returns: string };
      channel_feed: {
        Args: { p_chat: string; p_before?: string | null; p_before_id?: string | null; p_limit?: number };
        Returns: (Database['public']['Tables']['messages']['Row'] & { reacts: Partial<Record<ReactionKey, number>> | null })[];
      };
      edit_message: { Args: { p_id: string; p_body: string }; Returns: undefined };
      // Комментарии и эмодзи-статус (0.5.1)
      set_chat_comments: { Args: { p_chat: string; p_on: boolean }; Returns: undefined };
      comment_stats: { Args: { p_chat: string; p_ids: string[] }; Returns: CommentStats };
      comment_feed: {
        Args: { p_post: string; p_before?: string | null; p_before_id?: string | null; p_limit?: number };
        Returns: (Database['public']['Tables']['messages']['Row'] & {
          reacts: Partial<Record<ReactionKey, number>> | null; author: ProfileCard | null;
        })[];
      };
      set_emoji_status: { Args: { p_emoji: string | null; p_until?: string | null }; Returns: undefined };
      profile_cards: { Args: { p_ids: string[] }; Returns: ProfileCard[] };
      join_chat: { Args: { p_code: string }; Returns: string };
      reset_invite: { Args: { p_chat: string }; Returns: string };
      open_direct: { Args: { p_user: string }; Returns: string };
      delete_message: { Args: { p_id: string }; Returns: undefined };
      mark_read: { Args: { p_chat: string; p_at?: string }; Returns: undefined };
      leave_chat: { Args: { p_chat: string }; Returns: undefined };
      ping: { Args: { p_online?: boolean }; Returns: undefined };
      find_user: {
        Args: { p_username: string };
        Returns: { id: string; name: string | null; username: string | null; avatar_path: string | null; color: string }[];
      };
      search_users: {
        Args: { p_query: string; p_limit?: number };
        Returns: {
          id: string; name: string | null; username: string | null; avatar_path: string | null; color: string;
          is_contact: boolean; verified: boolean;
        }[];
      };
      username_available: { Args: { p_username: string }; Returns: boolean };
      set_identity_key: {
        Args: { p_public: string; p_backup: string; p_salt: string; p_iterations: number; p_reset?: boolean };
        Returns: undefined;
      };
      my_key_backup: {
        Args: Record<PropertyKey, never>;
        Returns: { public_key: string; backup: string; salt: string; iterations: number }[];
      };
      update_key_backup: { Args: { p_backup: string; p_salt: string; p_iterations: number }; Returns: undefined };
      call_start: { Args: { p_chat: string; p_video?: boolean; p_device?: string }; Returns: string };
      call_join: { Args: { p_call: string; p_device?: string }; Returns: { user_id: string; joined_at: string }[] };
      call_leave: { Args: { p_call: string; p_device?: string }; Returns: undefined };
      call_decline: { Args: { p_call: string }; Returns: undefined };
      call_ring: { Args: { p_call: string }; Returns: undefined };
      call_ping: {
        Args: { p_call: string; p_device?: string; p_muted?: boolean; p_deafened?: boolean; p_camera?: boolean; p_screen?: boolean };
        Returns: 'ok' | 'ended' | 'replaced' | 'gone';
      };
      my_calls: {
        Args: Record<PropertyKey, never>;
        Returns: {
          id: string; chat_id: string; started_by: string | null; video: boolean; created_at: string; rung_at: string;
          answered_at: string | null; ringing: boolean; server_now: string; members: CallMemberInfo[];
        }[];
      };
      /** Оценка СКАМ: средняя, число оценок, распределение [1★…5★] и моя оценка. */
      app_rating: {
        Args: Record<PropertyKey, never>;
        Returns: { avg: number; count: number; dist: number[]; mine: number | null };
      };
      rate_app: {
        Args: { p_stars: number };
        Returns: { avg: number; count: number; dist: number[]; mine: number | null };
      };
      /** Обычно вызывается из Edge Function support (она же отправляет письмо). */
      support_submit: {
        Args: { p_topic: string; p_body: string; p_meta?: Json | null };
        Returns: { id: string; no: string; email: string | null };
      };
      /** Я владелец СКАМ (могу выдавать официальные галочки)? */
      am_app_owner: { Args: Record<PropertyKey, never>; Returns: boolean };
      set_verified: { Args: { p_kind: 'user' | 'channel'; p_id: string; p_on: boolean }; Returns: undefined };
      /** Неофициальные наборы стикеров. */
      sticker_pack: { Args: { p_pack: string }; Returns: StickerPackInfo | null };
      my_sticker_packs: { Args: Record<PropertyKey, never>; Returns: StickerPackInfo[] };
      my_emoji_packs: { Args: Record<PropertyKey, never>; Returns: StickerPackInfo[] };
      create_emoji_pack: { Args: { p_title: string }; Returns: string };
      add_custom_emoji: { Args: { p_pack: string; p_id: string; p_name: string }; Returns: undefined };
      rename_custom_emoji: { Args: { p_pack: string; p_id: string; p_name: string }; Returns: undefined };
      set_reaction: { Args: { p_message: string; p_emoji: string; p_super?: boolean }; Returns: undefined };
      super_reaction_status: { Args: { p_chat: string }; Returns: SuperStatus | null };
      chat_visit: { Args: { p_chat: string }; Returns: undefined };
      /** Моё «Избранное»: найти или создать. */
      open_saved: { Args: Record<PropertyKey, never>; Returns: string };
      create_sticker_pack: { Args: { p_title: string }; Returns: string };
      rename_sticker_pack: { Args: { p_pack: string; p_title: string }; Returns: undefined };
      add_sticker: { Args: { p_pack: string; p_id: string; p_emoji: string }; Returns: undefined };
      set_sticker_emoji: { Args: { p_pack: string; p_id: string; p_emoji: string }; Returns: undefined };
      remove_sticker: { Args: { p_pack: string; p_id: string }; Returns: undefined };
      delete_sticker_pack: { Args: { p_pack: string }; Returns: undefined };
      add_sticker_pack: { Args: { p_pack: string }; Returns: undefined };
      remove_sticker_pack: { Args: { p_pack: string }; Returns: undefined };
      /** Папки с чатами и закреплённые чаты (только свои). */
      my_chat_layout: { Args: Record<PropertyKey, never>; Returns: ChatLayout };
      save_chat_folder: {
        Args: {
          p_id: string | null; p_title: string; p_emoji: string | null; p_kinds: FolderKind[];
          p_include: string[]; p_exclude: string[]; p_no_read: boolean;
        };
        Returns: string;
      };
      delete_chat_folder: { Args: { p_id: string }; Returns: undefined };
      reorder_chat_folders: { Args: { p_ids: string[] }; Returns: undefined };
      folder_set_chat: { Args: { p_folder: string; p_chat: string; p_in: boolean }; Returns: undefined };
      pin_chat: { Args: { p_chat: string; p_on: boolean; p_folder?: string | null }; Returns: undefined };
      reorder_pinned_chats: { Args: { p_ids: string[]; p_folder?: string | null }; Returns: undefined };
      /** Мои ники для людей (видны только мне) и как эти люди выглядят. */
      my_nicknames: { Args: Record<PropertyKey, never>; Returns: Nickname[] };
      /** Дать, изменить или убрать ник (пусто — убрать). Возвращает сохранённый ник или null. */
      set_nickname: { Args: { p_user: string; p_nickname: string | null }; Returns: string | null };
      /** «О себе» любого человека (профиль целиком виден только при общем чате). */
      user_bio: { Args: { p_user: string }; Returns: string | null };
      /** Принять редакцию Пользовательского соглашения и Политики (дата вида 2026-10-02). Возвращает время принятия. */
      accept_terms: { Args: { p_version: string }; Returns: string };
      /** Последняя принятая редакция документов (null — ещё не принимал). */
      my_terms: { Args: Record<PropertyKey, never>; Returns: string | null };
      e2e_pending: {
        Args: { p_limit?: number };
        Returns: { chat_id: string; key_id: string; user_id: string; public_key: string }[];
      };
      /** Заблокировать (p_on = true) или разблокировать человека. */
      block_user: { Args: { p_user: string; p_on: boolean }; Returns: undefined };
      /** Кого я заблокировал — свежие сверху. */
      my_blocks: { Args: Record<PropertyKey, never>; Returns: BlockedUser[] };
      /** «Без звука» для чата: p_until = null — навсегда; p_on = false — включить звук. */
      mute_chat: { Args: { p_chat: string; p_on: boolean; p_until?: string | null }; Returns: undefined };
      /** Мои чаты без звука (до какого времени; null — навсегда). */
      my_mutes: { Args: Record<PropertyKey, never>; Returns: { chat_id: string; until: string | null }[] };
      /** Группы, где есть и я, и этот человек. */
      common_groups: { Args: { p_user: string }; Returns: CommonGroup[] };
      /** Лента историй: я и люди, с кем есть личный чат, у кого есть живые истории. */
      story_feed: {
        Args: Record<PropertyKey, never>;
        Returns: {
          author_id: string; name: string | null; avatar_path: string | null; color: string | null; verified: boolean;
          stories: Story[]; unseen: number; last_at: string;
        }[];
      };
      /** Живые и закреплённые истории человека (для профиля); не видно — пустой список. */
      user_stories: { Args: { p_user: string }; Returns: Story[] };
      /** Кто смотрел мою историю (сначала с сердечком). */
      story_viewers: {
        Args: { p_story: string };
        Returns: {
          user_id: string; name: string | null; avatar_path: string | null; color: string | null; verified: boolean;
          viewed_at: string; liked: boolean;
        }[];
      };
      create_story: {
        Args: {
          p_id: string; p_kind: StoryKind; p_media_path: string | null; p_thumb_path: string | null; p_media_mime: string | null;
          p_w: number | null; p_h: number | null; p_duration_ms: number | null; p_body: string | null; p_bg: number | null;
        };
        Returns: string;
      };
      view_story: { Args: { p_story: string }; Returns: undefined };
      like_story: { Args: { p_story: string; p_on: boolean }; Returns: undefined };
      pin_story: { Args: { p_story: string; p_on: boolean }; Returns: undefined };
      delete_story: { Args: { p_story: string }; Returns: undefined };
      // Статьи (0.4.0)
      article_image_slot: { Args: { p_ext: string }; Returns: string };
      article_save: {
        Args: {
          p_id: string | null; p_title: string; p_author_name: string | null; p_author_url: string | null; p_content: Json;
          p_font?: ArticleFont | null;
        };
        Returns: { id: string; slug: string };
      };
      article_get: { Args: { p_slug: string }; Returns: ArticleFull | null };
      article_view: { Args: { p_slug: string }; Returns: undefined };
      article_cards: { Args: { p_slugs: string[] }; Returns: ArticleCard[] };
      my_articles: { Args: { p_limit?: number; p_offset?: number }; Returns: (ArticleCard & { id: string; updated_at: string; hidden: boolean })[] };
      article_delete: { Args: { p_id: string }; Returns: string[] };
      article_hide: { Args: { p_id: string; p_on: boolean }; Returns: undefined };
      // Опросы (0.4.0)
      send_poll: {
        Args: {
          p_id: string; p_chat: string; p_question: string | null; p_options: string[] | null; p_enc: string | null;
          p_key_id: string | null; p_count: number | null; p_multiple: boolean; p_anonymous: boolean; p_quiz: boolean;
          p_correct: number | null; p_solution: string | null;
        };
        Returns: Message[];
      };
      poll_vote: { Args: { p_message: string; p_options: number[] }; Returns: PollState };
      poll_close: { Args: { p_message: string }; Returns: PollState };
      poll_state: { Args: { p_ids: string[] }; Returns: PollState[] };
      poll_voters: {
        Args: { p_message: string; p_option?: number | null; p_limit?: number; p_offset?: number };
        Returns: { user_id: string; option: number; voted_at: string }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

/** Обычная реакция ('like'…) или своё эмодзи: 'c:<набор>/<эмодзи>'. */
export type ReactionKey = 'like' | 'lol' | 'fire' | 'wow' | 'clown' | `c:${string}`;
/**
 * Вид сообщения: text/system — текст; sticker, voice (голосовое), video_note (кружочек);
 * e2e — зашифрованное (содержимое внутри enc); media — вложения там, где E2E нет (канал, бот);
 * call — запись о звонке (что со звонком — в calls); poll — опрос там, где E2E нет (вопрос в body, варианты — в polls).
 */
export type MessageKind = 'text' | 'system' | 'sticker' | 'voice' | 'video_note' | 'e2e' | 'media' | 'call' | 'poll';
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type Profile = Tables<'profiles'>;
export type Chat = Tables<'chats'>;
export type Member = Tables<'chat_members'>;
export type Message = Tables<'messages'>;
export type Reaction = Tables<'reactions'>;
export type KeyShare = Tables<'chat_key_shares'>;
export type UserKey = Tables<'user_keys'>;
/** Чат из списка. preview — публичный канал, открытый до подписки (его нет в списке). */
export type MyChat = Database['public']['Functions']['my_chats']['Returns'][number] & { preview?: boolean };
export type Call = Tables<'calls'>;
export type CallMember = Tables<'call_members'>;
export type CallSignal = Tables<'call_signals'>;
export type ActiveCall = Database['public']['Functions']['my_calls']['Returns'][number];

/** Типы чатов, которые можно целиком положить в папку. */
export type FolderKind = 'direct' | 'group' | 'channel' | 'bot';

/**
 * Нейросеть бота СКАМ (0.4.2): enabled — доступна мне, agreed — я её включил в чате с ботом,
 * чья она, сколько ответов сегодня и из скольких, ждём ли ответа.
 */
export type BotAiStatus = { enabled: boolean; agreed: boolean; label: string; limit: number; used: number; pending: boolean };
/** Папка с чатами, как в Telegram: целые типы + выбранные чаты − исключённые; pinned — закреплённые в папке. */
export type ChatFolder = {
  id: string;
  title: string;
  /** Значок; null — подобрать по содержимому. */
  emoji: string | null;
  kinds: FolderKind[];
  include: string[];
  exclude: string[];
  pinned: string[];
  /** «Исключить прочитанные». */
  no_read: boolean;
};
/** Закреплённые в «Все чаты» (по порядку) и папки (по порядку). */
export type ChatLayout = { pins: string[]; folders: ChatFolder[] };

/** Мой ник для человека: видит только тот, кто его дал. Плюс как этот человек выглядит (как в search_users). */
export type Nickname = {
  user_id: string; nickname: string; name: string | null; username: string | null; avatar_path: string | null;
  color: string; verified: boolean;
};

/** История: фото, видео (до 60 с) или текст на градиентном фоне. Живёт сутки, закреплённая — пока не открепят. */
export type StoryKind = 'photo' | 'video' | 'text';
/** Заблокированный мной человек — как он выглядит. */
export type BlockedUser = {
  user_id: string; name: string | null; username: string | null; avatar_path: string | null; color: string | null;
  verified: boolean; created_at: string;
};

/** Общая группа с человеком. */
export type CommonGroup = { id: string; name: string | null; emoji: string; avatar_path: string | null; member_count: number };

export type Story = {
  id: string;
  author_id: string;
  kind: StoryKind;
  /** stories/<автор>/<id>.<ext> и превью <id>_t.jpg (у текста — null). */
  media_path: string | null;
  thumb_path: string | null;
  media_mime: string | null;
  w: number | null;
  h: number | null;
  duration_ms: number | null;
  /** Текст истории или подпись к фото и видео. */
  body: string | null;
  /** Фон текстовой истории: 0…7. */
  bg: number | null;
  pinned: boolean;
  created_at: string;
  expires_at: string;
  /** Я её уже смотрел (свои — всегда true). */
  seen: boolean;
  /** Я поставил сердечко. */
  liked: boolean;
  /** Только у своих: сколько посмотрели и сколько поставили сердечко. */
  views: number | null;
  likes: number | null;
};

/** Узел статьи в формате Telegraph: текст или элемент с тегом, атрибутами (href у ссылки, src у картинки) и детьми. */
export type ArticleNode = string | { tag: string; attrs?: { href?: string; src?: string; font?: string }; children?: ArticleNode[] };

/** Шрифт статьи или фрагмента (0.5.1). null у статьи — «с засечками», как было до шрифтов. */
export type ArticleFont = 'serif' | 'sans' | 'mono' | 'hand' | 'wide';

/** Карточка статьи — для ссылок в чатах и списка «Мои статьи». cover — картинка в бакете articles. */
export type ArticleCard = {
  slug: string; title: string; description: string; cover: string | null; author_name: string | null; views: number;
  created_at: string;
};

/** Статья целиком (article_get). mine — я автор; moderator — я из команды СКАМ (могу скрыть статью). */
export type ArticleFull = ArticleCard & {
  id: string; author_url: string | null; content: ArticleNode[]; updated_at: string; mine: boolean; hidden: boolean;
  moderator: boolean; font?: ArticleFont | null;
};

/** Карточка человека, видная без общего чата (авторы комментариев, profile_cards). */
export type ProfileCard = {
  id: string; name: string | null; username: string | null; avatar_path: string | null; color: string | null; verified: boolean;
  emoji_status: string | null; emoji_status_until: string | null;
};

/** Комментарии под постами канала (comment_stats): включены ли, могу ли писать, счётчики и трое последних. */
export type CommentStats = {
  on: boolean; can: boolean;
  posts: Record<string, { n: number; last: string; recent: string[] }>;
  people: Record<string, ProfileCard>;
};

/**
 * Опрос глазами спрашивающего (poll_state). options — тексты, только там, где нет E2E (иначе внутри сообщения).
 * correct и solution приходят только после своего голоса или когда опрос завершён; recent — последние голосовавшие
 * (только в открытом опросе).
 */
export type PollState = {
  id: string; chat_id: string; n: number; options: string[] | null; multiple: boolean; anonymous: boolean; quiz: boolean;
  counts: number[]; voters: number; closed: boolean; mine: number[]; correct: number | null; solution: string | null;
  recent: string[] | null; can_close: boolean; can_vote: boolean;
};
