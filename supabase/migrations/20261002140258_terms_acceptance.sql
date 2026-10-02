-- СКАМ — принятие Пользовательского соглашения и Политики конфиденциальности.
--
-- При создании аккаунта человек ставит галочку «Я принимаю Пользовательское соглашение и ознакомлен(а)
-- с Политикой конфиденциальности»; тем, кто зарегистрировался раньше или принял старую редакцию,
-- приложение один раз показывает экран «Правила СКАМ». Здесь хранится, кто какую редакцию и когда
-- принял (п. 13.4 Соглашения: данные базы — доказательство принятия). Редакция — дата вида 2026-10-02.
--
-- Скрипт идемпотентный.

create table if not exists private.terms_acceptances (
  user_id uuid not null references auth.users (id) on delete cascade,
  version text not null check (version ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at timestamptz not null default now(),
  primary key (user_id, version)
);
alter table private.terms_acceptances enable row level security;
revoke all on private.terms_acceptances from public, anon, authenticated;

-- Принять редакцию документов. Повторное принятие той же редакции ничего не меняет.
create or replace function public.accept_terms(p_version text)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_at timestamptz;
begin
  if v_uid is null then
    raise exception 'Нужно войти' using errcode = '42501';
  end if;
  if p_version is null or p_version !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception 'Неизвестная редакция документов' using errcode = '22023';
  end if;
  insert into private.terms_acceptances (user_id, version)
  values (v_uid, p_version)
  on conflict (user_id, version) do nothing;
  select a.accepted_at into v_at from private.terms_acceptances a
  where a.user_id = v_uid and a.version = p_version;
  return v_at;
end;
$$;

-- Последняя принятая редакция (null — ещё ничего не принимал).
create or replace function public.my_terms()
returns text
language sql stable security definer set search_path = ''
as $$
  select max(a.version) from private.terms_acceptances a where a.user_id = auth.uid();
$$;

revoke all on function public.accept_terms(text) from public, anon;
revoke all on function public.my_terms() from public, anon;
grant execute on function public.accept_terms(text) to authenticated;
grant execute on function public.my_terms() to authenticated;
