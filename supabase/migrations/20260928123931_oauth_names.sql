-- СКАМ — вход через Google, GitHub и Discord.
--
-- Провайдеры включаются в Supabase → Authentication → Sign In / Providers (там же — Client ID и секрет).
-- Схема базы для этого не меняется; здесь только новый аккаунт получает имя и фамилию из профиля
-- провайдера: Google и GitHub присылают полное имя одной строкой («Артур Гайнатуллин»),
-- Discord — отображаемое имя (global_name) и ник. Раньше строка целиком попадала в «Имя».
-- @username человек всё равно выбирает сам на экране «Создание аккаунта».
--
-- Скрипт идемпотентный.

create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  palette text[] := array['#F25A1E', '#B5400C', '#8FB224', '#D98A00', '#3A7CA5', '#7B4FA0', '#C2185B', '#00897B', '#5C6BC0', '#6E685E'];
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  fn text := nullif(btrim(coalesce(m ->> 'first_name', '')), '');
  ln text := nullif(btrim(coalesce(m ->> 'last_name', '')), '');
  full_n text;
begin
  if fn is null then
    fn := nullif(btrim(coalesce(m ->> 'given_name', '')), '');
    ln := coalesce(ln, nullif(btrim(coalesce(m ->> 'family_name', '')), ''));
  end if;
  -- Google / GitHub / Discord: полное имя одной строкой → имя и фамилия.
  if fn is null then
    full_n := nullif(btrim(regexp_replace(coalesce(
      m -> 'custom_claims' ->> 'global_name',  -- Discord: отображаемое имя
      m ->> 'full_name',
      m ->> 'name',
      ''), '#\d+$', '')), '');
    if full_n is not null then
      full_n := regexp_replace(full_n, '\s+', ' ', 'g');
      fn := split_part(full_n, ' ', 1);
      ln := coalesce(ln, nullif(btrim(substr(full_n, char_length(fn) + 2)), ''));
    end if;
  end if;

  insert into public.profiles (id, first_name, last_name, color)
  values (new.id, left(fn, 40), left(ln, 40), palette[1 + floor(random() * array_length(palette, 1))::int])
  on conflict (id) do nothing;

  insert into public.chat_members (chat_id, user_id)
  select c.id, new.id from public.chats c where c.is_default
  on conflict do nothing;

  perform private.ensure_bot_chat(new.id);
  return new;
end;
$$;
