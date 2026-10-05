-- SKAM: trigger and policies in auth, storage, realtime (not included in supabase db dump).
-- Safe to run again: sh server/apply-managed.sh
begin;
set local client_min_messages = warning;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

drop policy if exists "skam avatars: read own" on storage.objects;
create policy "skam avatars: read own" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "skam avatars: upload own" on storage.objects;
create policy "skam avatars: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "skam avatars: update own" on storage.objects;
create policy "skam avatars: update own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "skam avatars: delete own" on storage.objects;
create policy "skam avatars: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "skam chat avatars: read" on storage.objects;
create policy "skam chat avatars: read" on storage.objects for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'chat'
         and private.is_chat_member(private.try_uuid((storage.foldername(name))[2])));
drop policy if exists "skam chat avatars: upload" on storage.objects;
create policy "skam chat avatars: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'chat'
              and private.has_right(private.try_uuid((storage.foldername(name))[2]), 'info'));
drop policy if exists "skam chat avatars: delete" on storage.objects;
create policy "skam chat avatars: delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = 'chat'
         and private.has_right(private.try_uuid((storage.foldername(name))[2]), 'info'));

drop policy if exists "media: upload own" on storage.objects;
create policy "media: upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and split_part(name, '/', 2) = (select auth.uid())::text
              and private.can_post(private.path_chat(name)) and private.is_registered());
drop policy if exists "media: delete own" on storage.objects;
create policy "media: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and split_part(name, '/', 2) = (select auth.uid())::text);
drop policy if exists "media: members read" on storage.objects;
create policy "media: members read" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (private.is_chat_member(private.path_chat(name))
         or private.is_public_channel(private.path_chat(name))));

drop policy if exists "skam stickers: upload" on storage.objects;
create policy "skam stickers: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'stickers' and private.sticker_upload_ok(name));
drop policy if exists "skam stickers: read own" on storage.objects;
create policy "skam stickers: read own" on storage.objects for select to authenticated
  using (bucket_id = 'stickers' and (private.owns_sticker_pack(split_part(name, '/', 1))
         or private.is_app_owner()));
drop policy if exists "skam stickers: delete own" on storage.objects;
create policy "skam stickers: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'stickers' and (private.owns_sticker_pack(split_part(name, '/', 1))
         or private.is_app_owner()));

-- Stories (1.6.0): own folder <uid>/..., others read only live stories of people with a direct chat.
drop policy if exists "skam stories: upload" on storage.objects;
create policy "skam stories: upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'stories' and private.story_upload_ok(name));
drop policy if exists "skam stories: read" on storage.objects;
create policy "skam stories: read" on storage.objects for select to authenticated
  using (bucket_id = 'stories' and ((storage.foldername(name))[1] = (select auth.uid())::text
         or private.story_file_visible(name)));
drop policy if exists "skam stories: delete own" on storage.objects;
create policy "skam stories: delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'stories' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "skam: realtime read" on realtime.messages;
create policy "skam: realtime read" on realtime.messages for select to authenticated
  using (exists (select 1 from public.chat_members m
                 where m.user_id = (select auth.uid())
                   and 'chat:' || m.chat_id::text = (select realtime.topic())));
drop policy if exists "skam: realtime write" on realtime.messages;
create policy "skam: realtime write" on realtime.messages for insert to authenticated
  with check (exists (select 1 from public.chat_members m
                      where m.user_id = (select auth.uid())
                        and 'chat:' || m.chat_id::text = (select realtime.topic())));

commit;
