// Типы схемы из supabase/migrations/20260924000000_init.sql.
// Формат совместим с `supabase gen types typescript` — при желании файл можно перегенерировать:
//   npx supabase gen types typescript --project-id <ref> > src/lib/database.types.ts

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type ChatRow = {
  id: string;
  kind: 'group' | 'direct';
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
          name: string | null;
          avatar_path: string | null;
          color: string;
          created_at: string;
          updated_at: string;
        };
        Insert: never;
        Update: {
          name?: string | null;
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
          kind: 'text' | 'system';
          body: string;
          created_at: string;
          deleted_at: string | null;
        };
        Insert: {
          id?: string;
          chat_id: string;
          body: string;
        };
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
          kind: 'group' | 'direct';
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
          last_kind: 'text' | 'system' | null;
          last_at: string | null;
          last_deleted: boolean | null;
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
    };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};

export type ReactionKey = 'like' | 'lol' | 'fire' | 'wow' | 'clown';
export type Tables<T extends keyof Database['public']['Tables']> = Database['public']['Tables'][T]['Row'];
export type Profile = Tables<'profiles'>;
export type Chat = Tables<'chats'>;
export type Member = Tables<'chat_members'>;
export type Message = Tables<'messages'>;
export type Reaction = Tables<'reactions'>;
export type MyChat = Database['public']['Functions']['my_chats']['Returns'][number];
