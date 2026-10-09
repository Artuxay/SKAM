-- СКАМ 0.3.5: вернуть права таблиц и функций, как в миграциях (и как было в облаке до переезда 05.10).
--
-- При переносе базы на свой сервер права на объекты в public/private стали шире задуманного:
-- у anon и authenticated оказались ВСЕ права на все старые таблицы и EXECUTE на все функции.
-- Защищал только RLS, а колонки — нет. Например, можно было самому себе поставить profiles.verified
-- (официальную галочку), подделать created_at своих сообщений, а oauth_link/oauth_resolve и
-- support_claim/support_mark (только для service_role) были доступны любому.
-- Ниже — ровно те права, что стояли в облаке (сняты оттуда 09.10 запросом к pg_class/pg_proc).
-- Таблицы и функции, созданные уже на сервере (истории, блокировки, эмодзи), здесь не трогаются —
-- их права выставлены их миграциями.

-- ---------------------------------------------------------------------------
-- Таблицы
-- ---------------------------------------------------------------------------

revoke all on table public.app_ratings from anon, authenticated;
revoke all on table public.call_members from anon, authenticated; grant select on table public.call_members to authenticated;
revoke all on table public.call_signals from anon, authenticated; grant delete on table public.call_signals to authenticated; grant select on table public.call_signals to authenticated; grant insert (call_id, to_user, payload) on table public.call_signals to authenticated;
revoke all on table public.calls from anon, authenticated; grant select on table public.calls to authenticated;
revoke all on table public.chat_bans from anon, authenticated;
revoke all on table public.chat_folders from anon, authenticated;
revoke all on table public.chat_key_shares from anon, authenticated; grant select on table public.chat_key_shares to authenticated; grant insert (key_id, user_id, sender_pub, wrapped) on table public.chat_key_shares to authenticated;
revoke all on table public.chat_keys from anon, authenticated; grant select on table public.chat_keys to authenticated; grant insert (id, chat_id) on table public.chat_keys to authenticated;
revoke all on table public.chat_members from anon, authenticated; grant select on table public.chat_members to authenticated;
revoke all on table public.chat_pins from anon, authenticated;
revoke all on table public.chats from anon, authenticated; grant select (id, kind, name, emoji, created_by, direct_key, is_default, created_at, description, username, avatar_path, sign_messages, verified) on table public.chats to authenticated;
revoke all on table public.messages from anon, authenticated; grant select on table public.messages to authenticated; grant insert (id, chat_id, kind, body, sticker, media_path, media_mime, duration_ms, waveform, enc, key_id, files, reply_to, fwd) on table public.messages to authenticated;
revoke all on table public.profiles from anon, authenticated; grant select on table public.profiles to authenticated; grant select (verified, bio) on table public.profiles to authenticated; grant update (avatar_path, first_name, last_name, username, bio) on table public.profiles to authenticated;
revoke all on table public.reactions from anon, authenticated; grant delete on table public.reactions to authenticated; grant select on table public.reactions to authenticated; grant insert (message_id, emoji) on table public.reactions to authenticated;
revoke all on table public.sticker_packs from anon, authenticated;
revoke all on table public.stickers from anon, authenticated;
revoke all on table public.support_requests from anon, authenticated;
revoke all on table public.user_keys from anon, authenticated; grant select on table public.user_keys to authenticated;
revoke all on table public.user_nicknames from anon, authenticated;
revoke all on table public.user_sticker_packs from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Функции
-- ---------------------------------------------------------------------------

revoke all on function private.bot_reply() from public, anon, authenticated;
revoke all on function private.call_finish(p_call uuid, p_status text) from public, anon, authenticated;
revoke all on function private.call_leave_others(p_user uuid, p_keep uuid) from public, anon, authenticated;
revoke all on function private.call_member_left() from public, anon, authenticated;
revoke all on function private.call_peer_ok(p_call uuid, p_to uuid) from public, anon, authenticated; grant execute on function private.call_peer_ok(p_call uuid, p_to uuid) to authenticated;
revoke all on function private.call_tidy(p_call uuid) from public, anon, authenticated;
revoke all on function private.can_post(p_chat uuid) from public, anon, authenticated; grant execute on function private.can_post(p_chat uuid) to authenticated;
revoke all on function private.can_touch(p_chat uuid, p_target uuid) from public, anon, authenticated;
revoke all on function private.chat_key_shares_fill() from public, anon, authenticated;
revoke all on function private.chat_keys_fill() from public, anon, authenticated;
revoke all on function private.chat_layout_cleanup() from public, anon, authenticated;
revoke all on function private.chat_rights_all(p_kind text) from public, anon, authenticated;
revoke all on function private.chat_username_ok(p_chat uuid, p_username text) from public, anon, authenticated;
revoke all on function private.ensure_bot_chat(p_user uuid) from public, anon, authenticated;
revoke all on function private.files_owned(p jsonb, p_chat uuid) from public, anon, authenticated; grant execute on function private.files_owned(p jsonb, p_chat uuid) to authenticated;
revoke all on function private.files_shape_ok(p jsonb) from public, anon, authenticated; grant execute on function private.files_shape_ok(p jsonb) to authenticated;
revoke all on function private.fwd_shape_ok(p jsonb) from public, anon, authenticated; grant execute on function private.fwd_shape_ok(p jsonb) to authenticated;
revoke all on function private.has_right(p_chat uuid, p_right text) from public, anon, authenticated; grant execute on function private.has_right(p_chat uuid, p_right text) to authenticated;
revoke all on function private.is_app_owner() from public, anon, authenticated; grant execute on function private.is_app_owner() to authenticated;
revoke all on function private.is_banned(p_chat uuid, p_user uuid) from public, anon, authenticated;
revoke all on function private.is_channel(p_chat uuid) from public, anon, authenticated; grant execute on function private.is_channel(p_chat uuid) to authenticated;
revoke all on function private.is_chat_member(p_chat uuid) from public, anon, authenticated; grant execute on function private.is_chat_member(p_chat uuid) to authenticated;
revoke all on function private.is_e2e_member(p_chat uuid) from public, anon, authenticated; grant execute on function private.is_e2e_member(p_chat uuid) to authenticated;
revoke all on function private.is_member_of(p_chat uuid, p_user uuid) from public, anon, authenticated; grant execute on function private.is_member_of(p_chat uuid, p_user uuid) to authenticated;
revoke all on function private.is_public_channel(p_chat uuid) from public, anon, authenticated; grant execute on function private.is_public_channel(p_chat uuid) to authenticated;
revoke all on function private.is_registered() from public, anon, authenticated; grant execute on function private.is_registered() to authenticated;
revoke all on function private.key_in_chat(p_key uuid, p_chat uuid) from public, anon, authenticated; grant execute on function private.key_in_chat(p_key uuid, p_chat uuid) to authenticated;
revoke all on function private.messages_stamp() from public, anon, authenticated;
revoke all on function private.msg_in_chat(p_msg uuid, p_chat uuid) from public, anon, authenticated; grant execute on function private.msg_in_chat(p_msg uuid, p_chat uuid) to authenticated;
revoke all on function private.my_chat_ids(p_ids uuid[]) from public, anon, authenticated;
revoke all on function private.my_role(p_chat uuid) from public, anon, authenticated; grant execute on function private.my_role(p_chat uuid) to authenticated;
revoke all on function private.owns_sticker_pack(p_pack text) from public, anon, authenticated; grant execute on function private.owns_sticker_pack(p_pack text) to authenticated;
revoke all on function private.path_chat(p_name text) from public, anon, authenticated; grant execute on function private.path_chat(p_name text) to authenticated;
revoke all on function private.profiles_guard() from public, anon, authenticated;
revoke all on function private.profiles_username_free() from public, anon, authenticated;
revoke all on function private.require_registered() from public, anon, authenticated; grant execute on function private.require_registered() to authenticated;
revoke all on function private.rights_of(p_chat uuid, p_user uuid) from public, anon, authenticated;
revoke all on function private.search_norm(p text) from public, anon, authenticated;
revoke all on function private.shares_chat(p_user uuid) from public, anon, authenticated; grant execute on function private.shares_chat(p_user uuid) to authenticated;
revoke all on function private.sticker_pack_json(p_pack text) from public, anon, authenticated;
revoke all on function private.sticker_upload_ok(p_name text) from public, anon, authenticated; grant execute on function private.sticker_upload_ok(p_name text) to authenticated;
revoke all on function private.try_uuid(p text) from public, anon, authenticated; grant execute on function private.try_uuid(p text) to authenticated;
revoke all on function public.accept_terms(p_version text) from public, anon, authenticated; grant execute on function public.accept_terms(p_version text) to authenticated;
revoke all on function public.add_chat_members(p_chat uuid, p_users uuid[]) from public, anon, authenticated; grant execute on function public.add_chat_members(p_chat uuid, p_users uuid[]) to authenticated;
revoke all on function public.add_sticker(p_pack text, p_id text, p_emoji text) from public, anon, authenticated; grant execute on function public.add_sticker(p_pack text, p_id text, p_emoji text) to authenticated;
revoke all on function public.add_sticker_pack(p_pack text) from public, anon, authenticated; grant execute on function public.add_sticker_pack(p_pack text) to authenticated;
revoke all on function public.am_app_owner() from public, anon, authenticated; grant execute on function public.am_app_owner() to authenticated;
revoke all on function public.app_rating() from public, anon, authenticated; grant execute on function public.app_rating() to authenticated;
revoke all on function public.call_decline(p_call uuid) from public, anon, authenticated; grant execute on function public.call_decline(p_call uuid) to authenticated;
revoke all on function public.call_join(p_call uuid, p_device uuid) from public, anon, authenticated; grant execute on function public.call_join(p_call uuid, p_device uuid) to authenticated;
revoke all on function public.call_leave(p_call uuid, p_device uuid) from public, anon, authenticated; grant execute on function public.call_leave(p_call uuid, p_device uuid) to authenticated;
revoke all on function public.call_ping(p_call uuid, p_device uuid, p_muted boolean, p_deafened boolean, p_camera boolean, p_screen boolean) from public, anon, authenticated; grant execute on function public.call_ping(p_call uuid, p_device uuid, p_muted boolean, p_deafened boolean, p_camera boolean, p_screen boolean) to authenticated;
revoke all on function public.call_ring(p_call uuid) from public, anon, authenticated; grant execute on function public.call_ring(p_call uuid) to authenticated;
revoke all on function public.call_start(p_chat uuid, p_video boolean, p_device uuid) from public, anon, authenticated; grant execute on function public.call_start(p_chat uuid, p_video boolean, p_device uuid) to authenticated;
revoke all on function public.channel_feed(p_chat uuid, p_before timestamp with time zone, p_before_id uuid, p_limit integer) from public, anon, authenticated; grant execute on function public.channel_feed(p_chat uuid, p_before timestamp with time zone, p_before_id uuid, p_limit integer) to authenticated;
revoke all on function public.chat_banned(p_chat uuid) from public, anon, authenticated; grant execute on function public.chat_banned(p_chat uuid) to authenticated;
revoke all on function public.chat_by_invite(p_code text) from public, anon, authenticated; grant execute on function public.chat_by_invite(p_code text) to authenticated;
revoke all on function public.chat_by_username(p_username text) from public, anon, authenticated; grant execute on function public.chat_by_username(p_username text) to authenticated;
revoke all on function public.chat_member_list(p_chat uuid, p_query text, p_admins boolean, p_limit integer, p_offset integer) from public, anon, authenticated; grant execute on function public.chat_member_list(p_chat uuid, p_query text, p_admins boolean, p_limit integer, p_offset integer) to authenticated;
revoke all on function public.chat_username_available(p_chat uuid, p_username text) from public, anon, authenticated; grant execute on function public.chat_username_available(p_chat uuid, p_username text) to authenticated;
revoke all on function public.create_chat(p_name text, p_emoji text, p_kind text, p_description text) from public, anon, authenticated; grant execute on function public.create_chat(p_name text, p_emoji text, p_kind text, p_description text) to authenticated;
revoke all on function public.create_sticker_pack(p_title text) from public, anon, authenticated; grant execute on function public.create_sticker_pack(p_title text) to authenticated;
revoke all on function public.delete_chat(p_chat uuid) from public, anon, authenticated; grant execute on function public.delete_chat(p_chat uuid) to authenticated;
revoke all on function public.delete_chat_folder(p_id uuid) from public, anon, authenticated; grant execute on function public.delete_chat_folder(p_id uuid) to authenticated;
revoke all on function public.delete_message(p_id uuid) from public, anon, authenticated; grant execute on function public.delete_message(p_id uuid) to authenticated;
revoke all on function public.delete_sticker_pack(p_pack text) from public, anon, authenticated; grant execute on function public.delete_sticker_pack(p_pack text) to authenticated;
revoke all on function public.e2e_pending(p_limit integer) from public, anon, authenticated; grant execute on function public.e2e_pending(p_limit integer) to authenticated;
revoke all on function public.edit_message(p_id uuid, p_body text) from public, anon, authenticated; grant execute on function public.edit_message(p_id uuid, p_body text) to authenticated;
revoke all on function public.find_user(p_username text) from public, anon, authenticated; grant execute on function public.find_user(p_username text) to authenticated;
revoke all on function public.folder_set_chat(p_folder uuid, p_chat uuid, p_in boolean) from public, anon, authenticated; grant execute on function public.folder_set_chat(p_folder uuid, p_chat uuid, p_in boolean) to authenticated;
revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.join_channel(p_chat uuid) from public, anon, authenticated; grant execute on function public.join_channel(p_chat uuid) to authenticated;
revoke all on function public.join_chat(p_code text) from public, anon, authenticated; grant execute on function public.join_chat(p_code text) to authenticated;
revoke all on function public.leave_chat(p_chat uuid) from public, anon, authenticated; grant execute on function public.leave_chat(p_chat uuid) to authenticated;
revoke all on function public.mark_read(p_chat uuid, p_at timestamp with time zone) from public, anon, authenticated; grant execute on function public.mark_read(p_chat uuid, p_at timestamp with time zone) to authenticated;
revoke all on function public.my_calls() from public, anon, authenticated; grant execute on function public.my_calls() to authenticated;
revoke all on function public.my_chat_layout() from public, anon, authenticated; grant execute on function public.my_chat_layout() to authenticated;
revoke all on function public.my_chats() from public, anon, authenticated; grant execute on function public.my_chats() to authenticated;
revoke all on function public.my_contacts(p_chat uuid, p_limit integer) from public, anon, authenticated; grant execute on function public.my_contacts(p_chat uuid, p_limit integer) to authenticated;
revoke all on function public.my_key_backup() from public, anon, authenticated; grant execute on function public.my_key_backup() to authenticated;
revoke all on function public.my_nicknames() from public, anon, authenticated; grant execute on function public.my_nicknames() to authenticated;
revoke all on function public.my_sticker_packs() from public, anon, authenticated; grant execute on function public.my_sticker_packs() to authenticated;
revoke all on function public.my_terms() from public, anon, authenticated; grant execute on function public.my_terms() to authenticated;
revoke all on function public.oauth_link(p_provider text, p_subject text, p_user uuid) from public, anon, authenticated;
revoke all on function public.oauth_resolve(p_provider text, p_subject text, p_email text) from public, anon, authenticated;
revoke all on function public.open_direct(p_user uuid) from public, anon, authenticated; grant execute on function public.open_direct(p_user uuid) to authenticated;
revoke all on function public.pin_chat(p_chat uuid, p_on boolean, p_folder uuid) from public, anon, authenticated; grant execute on function public.pin_chat(p_chat uuid, p_on boolean, p_folder uuid) to authenticated;
revoke all on function public.ping(p_online boolean) from public, anon, authenticated; grant execute on function public.ping(p_online boolean) to authenticated;
revoke all on function public.rate_app(p_stars integer) from public, anon, authenticated; grant execute on function public.rate_app(p_stars integer) to authenticated;
revoke all on function public.reactions_fill_chat() from public, anon, authenticated;
revoke all on function public.remove_chat_admin(p_chat uuid, p_user uuid) from public, anon, authenticated; grant execute on function public.remove_chat_admin(p_chat uuid, p_user uuid) to authenticated;
revoke all on function public.remove_chat_member(p_chat uuid, p_user uuid, p_ban boolean) from public, anon, authenticated; grant execute on function public.remove_chat_member(p_chat uuid, p_user uuid, p_ban boolean) to authenticated;
revoke all on function public.remove_sticker(p_pack text, p_id text) from public, anon, authenticated; grant execute on function public.remove_sticker(p_pack text, p_id text) to authenticated;
revoke all on function public.remove_sticker_pack(p_pack text) from public, anon, authenticated; grant execute on function public.remove_sticker_pack(p_pack text) to authenticated;
revoke all on function public.rename_sticker_pack(p_pack text, p_title text) from public, anon, authenticated; grant execute on function public.rename_sticker_pack(p_pack text, p_title text) to authenticated;
revoke all on function public.reorder_chat_folders(p_ids uuid[]) from public, anon, authenticated; grant execute on function public.reorder_chat_folders(p_ids uuid[]) to authenticated;
revoke all on function public.reorder_pinned_chats(p_ids uuid[], p_folder uuid) from public, anon, authenticated; grant execute on function public.reorder_pinned_chats(p_ids uuid[], p_folder uuid) to authenticated;
revoke all on function public.reset_invite(p_chat uuid) from public, anon, authenticated; grant execute on function public.reset_invite(p_chat uuid) to authenticated;
revoke all on function public.save_chat_folder(p_id uuid, p_title text, p_emoji text, p_kinds text[], p_include uuid[], p_exclude uuid[], p_no_read boolean) from public, anon, authenticated; grant execute on function public.save_chat_folder(p_id uuid, p_title text, p_emoji text, p_kinds text[], p_include uuid[], p_exclude uuid[], p_no_read boolean) to authenticated;
revoke all on function public.search_chats(p_query text, p_limit integer) from public, anon, authenticated; grant execute on function public.search_chats(p_query text, p_limit integer) to authenticated;
revoke all on function public.search_users(p_query text, p_limit integer) from public, anon, authenticated; grant execute on function public.search_users(p_query text, p_limit integer) to authenticated;
revoke all on function public.set_chat_admin(p_chat uuid, p_user uuid, p_rights text[]) from public, anon, authenticated; grant execute on function public.set_chat_admin(p_chat uuid, p_user uuid, p_rights text[]) to authenticated;
revoke all on function public.set_chat_avatar(p_chat uuid, p_path text) from public, anon, authenticated; grant execute on function public.set_chat_avatar(p_chat uuid, p_path text) to authenticated;
revoke all on function public.set_chat_username(p_chat uuid, p_username text) from public, anon, authenticated; grant execute on function public.set_chat_username(p_chat uuid, p_username text) to authenticated;
revoke all on function public.set_identity_key(p_public text, p_backup text, p_salt text, p_iterations integer, p_reset boolean) from public, anon, authenticated; grant execute on function public.set_identity_key(p_public text, p_backup text, p_salt text, p_iterations integer, p_reset boolean) to authenticated;
revoke all on function public.set_nickname(p_user uuid, p_nickname text) from public, anon, authenticated; grant execute on function public.set_nickname(p_user uuid, p_nickname text) to authenticated;
revoke all on function public.set_sticker_emoji(p_pack text, p_id text, p_emoji text) from public, anon, authenticated; grant execute on function public.set_sticker_emoji(p_pack text, p_id text, p_emoji text) to authenticated;
revoke all on function public.set_verified(p_kind text, p_id uuid, p_on boolean) from public, anon, authenticated; grant execute on function public.set_verified(p_kind text, p_id uuid, p_on boolean) to authenticated;
revoke all on function public.sticker_pack(p_pack text) from public, anon, authenticated; grant execute on function public.sticker_pack(p_pack text) to authenticated;
revoke all on function public.support_claim(p_id uuid, p_limit integer) from public, anon, authenticated;
revoke all on function public.support_mark(p_id uuid, p_error text) from public, anon, authenticated;
revoke all on function public.support_submit(p_topic text, p_body text, p_meta jsonb) from public, anon, authenticated; grant execute on function public.support_submit(p_topic text, p_body text, p_meta jsonb) to authenticated;
revoke all on function public.touch_updated_at() from public, anon, authenticated;
revoke all on function public.transfer_chat_owner(p_chat uuid, p_user uuid) from public, anon, authenticated; grant execute on function public.transfer_chat_owner(p_chat uuid, p_user uuid) to authenticated;
revoke all on function public.unban_chat_member(p_chat uuid, p_user uuid) from public, anon, authenticated; grant execute on function public.unban_chat_member(p_chat uuid, p_user uuid) to authenticated;
revoke all on function public.update_chat(p_chat uuid, p_name text, p_emoji text, p_description text, p_sign boolean) from public, anon, authenticated; grant execute on function public.update_chat(p_chat uuid, p_name text, p_emoji text, p_description text, p_sign boolean) to authenticated;
revoke all on function public.update_key_backup(p_backup text, p_salt text, p_iterations integer) from public, anon, authenticated; grant execute on function public.update_key_backup(p_backup text, p_salt text, p_iterations integer) to authenticated;
revoke all on function public.user_bio(p_user uuid) from public, anon, authenticated; grant execute on function public.user_bio(p_user uuid) to authenticated;
revoke all on function public.username_available(p_username text) from public, anon, authenticated; grant execute on function public.username_available(p_username text) to authenticated;

notify pgrst, 'reload schema';
