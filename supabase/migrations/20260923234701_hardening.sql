-- СКАМ — доводка по рекомендациям Supabase Advisors.
-- 1) Служебная функция is_chat_member уходит в схему private: RLS-политики её используют,
--    но через Data API (/rest/v1/rpc) она больше не видна. Политики ссылаются на функцию
--    по OID, поэтому переносить их не нужно.
-- 2) Индексы на внешние ключи (удаление пользователя, выборки по автору).

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

do $$
begin
  if to_regprocedure('public.is_chat_member(uuid)') is not null then
    if to_regprocedure('private.is_chat_member(uuid)') is not null then
      drop function private.is_chat_member(uuid);
    end if;
    alter function public.is_chat_member(uuid) set schema private;
  end if;
end $$;

revoke execute on function private.is_chat_member(uuid) from public, anon;
grant execute on function private.is_chat_member(uuid) to authenticated;

create index if not exists chats_created_by_idx on public.chats (created_by);
create index if not exists messages_user_idx on public.messages (user_id);
create index if not exists reactions_user_idx on public.reactions (user_id);

notify pgrst, 'reload schema';
