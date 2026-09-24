-- СКАМ — поиск людей не только по @username, но и по имени (нику).
-- • «@ivan» — ищет по началу @username.
-- • «Иван», «иван пет», «Петров Иван», «ivan_p» — каждое слово запроса должно совпасть
--   с началом имени, фамилии или @username. Регистр и «ё/е» не важны.
-- • Запрос от 2 символов, не больше 20 результатов — чтобы нельзя было выгрузить список
--   всех пользователей одним запросом.
-- • Отдаётся только карточка: имя, @username, аватарка и цвет. Статус «в сети» и остальной
--   профиль по-прежнему видят только собеседники (private.shares_chat).
-- • Сначала точное совпадение @username, потом те, с кем уже есть общий чат, потом остальные.
-- find_user (точный @username) оставлен для старых версий приложения.
-- Скрипт идемпотентный.

-- Нормализация для поиска: нижний регистр, «ё» → «е», без пробелов по краям.
create or replace function private.search_norm(p text)
returns text
language sql immutable parallel safe set search_path = ''
as $$
  select translate(lower(btrim(coalesce(p, ''))), 'ё', 'е');
$$;
revoke all on function private.search_norm(text) from public, anon, authenticated;

create or replace function public.search_users(p_query text, p_limit integer default 20)
returns table (id uuid, name text, username text, avatar_path text, color text, is_contact boolean)
language sql stable security definer set search_path = ''
as $$
  with q as (
    -- «@» в начале — искать только по @username.
    select left(n, 1) = '@' as at,
           btrim(regexp_replace(ltrim(n, '@'), '\s+', ' ', 'g')) as s
    from (select private.search_norm(p_query) as n) x
  ),
  t as (
    select q.at, q.s, string_to_array(q.s, ' ') as toks
    from q
    where (select auth.uid()) is not null
      and char_length(q.s) between 2 and 64
  ),
  contacts as (
    -- Люди, с которыми у меня есть общий групповой или личный чат.
    select distinct b.user_id
    from public.chat_members a
    join public.chat_members b on b.chat_id = a.chat_id
    join public.chats c on c.id = a.chat_id and c.kind in ('group', 'direct')
    where a.user_id = (select auth.uid())
  ),
  cand as (
    select p.id, p.name, p.username, p.avatar_path, p.color,
           private.search_norm(p.name) as nm,
           private.search_norm(coalesce(p.last_name || ' ', '') || p.first_name) as rev,
           -- Слова профиля: по пробелам и по дефисам («Анна-Мария» найдётся и по «мар»), плюс @username.
           regexp_split_to_array(private.search_norm(p.name), '\s+')
             || regexp_split_to_array(private.search_norm(p.name), '[\s-]+')
             || p.username as words
    from public.profiles p
    where p.first_name is not null
  ),
  hit as (
    select cand.id, cand.name, cand.username, cand.avatar_path, cand.color, cand.nm, cand.rev, t.s
    from cand, t
    where (t.at and starts_with(cand.username, t.s))
       or (not t.at and (
             starts_with(cand.nm, t.s)
             or starts_with(cand.rev, t.s)
             or starts_with(cand.username, t.s)
             or (select bool_and(exists (
                   select 1 from unnest(cand.words) w where starts_with(w, tok)
                 )) from unnest(t.toks) tok)
          ))
  )
  select h.id, h.name, h.username, h.avatar_path, h.color,
         (h.id <> (select auth.uid()) and h.id in (select user_id from contacts)) as is_contact
  from hit h
  order by
    coalesce(h.username = h.s, false) desc,
    (h.id <> (select auth.uid()) and h.id in (select user_id from contacts)) desc,
    case
      when starts_with(h.nm, h.s) or starts_with(h.rev, h.s) then 0
      when starts_with(h.username, h.s) then 1
      else 2
    end,
    (h.id = (select auth.uid())),
    h.nm,
    h.id
  limit least(greatest(coalesce(p_limit, 20), 1), 20);
$$;

revoke execute on function public.search_users(text, integer) from public, anon;
grant execute on function public.search_users(text, integer) to authenticated;

notify pgrst, 'reload schema';
