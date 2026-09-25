// Типы схемы из supabase/migrations.
// Формат совместим с `supabase gen types typescript` — при желании файл можно перегенерировать:
//   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type ChatKind = 'group' | 'direct' | 'channel' | 'bot';


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
          avatar_path: string | null;
          color: string;
          last_seen_at: string | null;
          online_until: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: {
          first_name?: string | null;
          last_name?: string | null;
          username?: string | null;
          avatar_path?: string | null;
        };
        Relationships: [];
      };
      chats: {
        Row: ChatRow;
        Insert: never;
        Update: {
          name?: string | null;
          emoji?: string;
        };
        Relationships: [];
      };
      chat_members: {
        Row: {
          chat_id: string;
          user_id: string;
          role: 'owner' | 'member';
          joined_at: string;
          last_read_at: string;
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
        };
        Insert: {
          message_id: string;
          emoji: ReactionKey;
        };
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
          role: 'owner' | 'member';
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
        }[];
      };
      create_chat: { Args: { p_name: string; p_emoji?: string }; Returns: ChatRow };
      chat_by_invite: {
        Args: { p_code: string };
        Returns: { id: string; name: string; emoji: string; member_count: number; is_member: boolean }[];
      };
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
          is_contact: boolean;
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
      e2e_pending: {
        Args: { p_limit?: number };
        Returns: { chat_id: string; key_id: string; user_id: string; public_key: string }[];
      };
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type ReactionKey = 'like' | 'lol' | 'fire' | 'wow' | 'clown';
/**
 * Вид сообщения: text/system — текст; sticker, voice (голосовое), video_note (кружочек);
 * e2e — зашифрованное (содержимое внутри enc); media — вложения там, где E2E нет (канал, бот);
 * call — запись о звонке (что со звонком — в calls).
 */
export type MessageKind = 'text' | 'system' | 'sticker' | 'voice' | 'video_note' | 'e2e' | 'media' | 'call';
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type Profile = Tables<'profiles'>;
export type Chat = Tables<'chats'>;
export type Member = Tables<'chat_members'>;
export type Message = Tables<'messages'>;
export type Reaction = Tables<'reactions'>;
export type KeyShare = Tables<'chat_key_shares'>;
export type UserKey = Tables<'user_keys'>;
export type MyChat = Database['public']['Functions']['my_chats']['Returns'][number];
export type Call = Tables<'calls'>;
export type CallMember = Tables<'call_members'>;
export type CallSignal = Tables<'call_signals'>;
export type ActiveCall = Database['public']['Functions']['my_calls']['Returns'][number];
