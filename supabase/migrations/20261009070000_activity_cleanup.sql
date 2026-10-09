-- СКАМ 0.3.5: дни активности (для супер-реакций) хранятся не дольше 45 дней у всех,
-- а не только у тех, кто снова открывает чаты. Уборка — при каждом chat_visit, по индексу дат (обычно ничего не находит).

create index if not exists chat_activity_day_idx on private.chat_activity (day);

create or replace function public.chat_visit(p_chat uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
begin
  if v_me is null or not private.is_chat_member(p_chat) then
    return;
  end if;
  perform private.note_activity(v_me, p_chat, false, false);
  delete from private.chat_activity where day < private.msk_today() - 45;
end;
$$;

revoke all on function public.chat_visit(uuid) from public, anon;
grant execute on function public.chat_visit(uuid) to authenticated, service_role;
