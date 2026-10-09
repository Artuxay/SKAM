-- СКАМ 0.3.5: право на супер-реакцию проверяет сам триггер reactions_guard — при любой вставке,
-- а не только в set_reaction. На сервере у authenticated сейчас есть INSERT на все колонки reactions
-- (права таблиц после переезда шире, чем в миграциях), и строку с super = true можно было бы вставить напрямую.

create or replace function private.reactions_guard()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_ref text;
  v_st jsonb;
  n int;
begin
  if new.emoji like 'c:%' then
    v_ref := substr(new.emoji, 3);
    if not exists (
      select 1 from public.stickers s join public.sticker_packs p on p.id = s.pack_id
      where p.kind = 'emoji' and s.pack_id = split_part(v_ref, '/', 1) and s.id = split_part(v_ref, '/', 2)
    ) then
      raise exception 'Этого эмодзи больше нет — его удалил автор набора' using errcode = 'P0002';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('reactions:' || new.message_id::text || ':' || new.user_id::text, 0));
  select count(*) into n from public.reactions where message_id = new.message_id and user_id = new.user_id;
  if n >= 3 then
    raise exception 'На одно сообщение — не больше 3 реакций. Уберите одну из своих' using errcode = '54000';
  end if;
  if new.super then
    v_st := private.super_status(new.user_id, new.chat_id);
    if not (v_st ->> 'available')::boolean then
      raise exception 'Супер-реакции есть только в группах и каналах' using errcode = '22023';
    end if;
    if not (v_st ->> 'eligible')::boolean then
      raise exception 'Супер-реакция откроется, когда вы побудете активным в этом чате' using errcode = '42501';
    end if;
    if (v_st ->> 'left')::int <= 0 then
      raise exception 'Супер-реакции в этом чате на сегодня закончились — завтра будут новые' using errcode = '54000';
    end if;
  end if;
  return new;
end;
$$;

-- set_reaction: проверки супер-реакции — в триггере; здесь только замена вида (обычная ↔ супер).
create or replace function public.set_reaction(p_message uuid, p_emoji text, p_super boolean default false)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_me uuid := (select auth.uid());
  v_super boolean := coalesce(p_super, false);
  v_chat uuid;
  v_cur boolean;
  v_had boolean;
begin
  if v_me is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select m.chat_id into v_chat from public.messages m where m.id = p_message and m.deleted_at is null;
  if v_chat is null or not private.is_chat_member(v_chat) then
    raise exception 'Сообщение не найдено' using errcode = 'P0002';
  end if;
  select r.super into v_cur from public.reactions r where r.message_id = p_message and r.user_id = v_me and r.emoji = p_emoji;
  v_had := found;
  if v_had and v_cur = v_super then
    return;
  end if;
  if v_had then
    delete from public.reactions where message_id = p_message and user_id = v_me and emoji = p_emoji;
  end if;
  insert into public.reactions (message_id, emoji, super) values (p_message, p_emoji, v_super);
end;
$$;

revoke all on function private.reactions_guard() from public, anon, authenticated;
revoke all on function public.set_reaction(uuid, text, boolean) from public, anon;
grant execute on function public.set_reaction(uuid, text, boolean) to authenticated, service_role;

notify pgrst, 'reload schema';
