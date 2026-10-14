-- Notelume database schema for the Supabase "notepad" project.
-- Run once in Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
-- Safe to re-run: every statement is idempotent.

-- ---------------------------------------------------------------------------
-- Notes: one row per note, owned by the signed-in user.
-- ---------------------------------------------------------------------------
create table if not exists public.notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title       text not null default '',
  type        text not null default 'plain',
  body        text not null default '',
  tasks       jsonb,
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint notes_type_check  check (type in ('plain', 'rich', 'markdown', 'tasks')),
  constraint notes_title_size  check (char_length(title) <= 200),
  constraint notes_body_size   check (octet_length(body) <= 3000000),  -- room for a few compressed images
  constraint notes_tasks_size  check (tasks is null or octet_length(tasks::text) <= 200000)
);

create index if not exists notes_user_updated_idx on public.notes (user_id, updated_at desc);

alter table public.notes enable row level security;

-- Each person can only see and change their own notes.
-- (select auth.uid()) is evaluated once per query rather than once per row.
drop policy if exists "notes_select_own" on public.notes;
create policy "notes_select_own" on public.notes
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "notes_insert_own" on public.notes;
create policy "notes_insert_own" on public.notes
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "notes_update_own" on public.notes;
create policy "notes_update_own" on public.notes
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists "notes_delete_own" on public.notes;
create policy "notes_delete_own" on public.notes
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Shared notes: anyone with the link can read ONE public note by its id.
-- A function (not a select policy) so nobody can list every public note,
-- and so the owner's user_id is never exposed.
-- ---------------------------------------------------------------------------
create or replace function public.get_shared_note(note_id uuid)
returns table (id uuid, title text, type text, body text, tasks jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.title, n.type, n.body, n.tasks, n.updated_at
  from public.notes n
  where n.id = note_id and n.is_public;
$$;

revoke all on function public.get_shared_note(uuid) from public;
grant execute on function public.get_shared_note(uuid) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Assistant usage: per-person daily counter used by the "ask" Edge Function.
-- No policies on purpose: rows are only touched through bump_ai_usage().
-- ---------------------------------------------------------------------------
create table if not exists public.ai_usage (
  user_id  uuid not null references auth.users (id) on delete cascade,
  day      date not null default current_date,
  count    integer not null default 0,
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

create or replace function public.bump_ai_usage(p_limit integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c integer;
begin
  if auth.uid() is null then
    return false;
  end if;
  insert into public.ai_usage (user_id, day, count)
  values (auth.uid(), current_date, 1)
  on conflict (user_id, day) do update set count = public.ai_usage.count + 1
  returning count into c;
  return c <= p_limit;
end;
$$;

revoke all on function public.bump_ai_usage(integer) from public;
revoke execute on function public.bump_ai_usage(integer) from anon; -- Supabase grants anon by default
grant execute on function public.bump_ai_usage(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- v2: pinned notes, expiring share links, password-protected share links.
-- ---------------------------------------------------------------------------
alter table public.notes add column if not exists pinned boolean not null default false;
alter table public.notes add column if not exists share_expires_at timestamptz;
alter table public.notes add column if not exists share_password_hash text;

-- Projects created before images were supported had a 500 KB body limit; raise it to 3 MB.
alter table public.notes drop constraint if exists notes_body_size;
alter table public.notes add constraint notes_body_size check (octet_length(body) <= 3000000);

create extension if not exists pgcrypto with schema extensions;

-- Owner changes how a note is shared. The password is hashed here and never stored in plain text.
-- p_password: null keeps the current password, a value sets a new one; p_clear_password removes it.
create or replace function public.set_note_sharing(
  p_note_id uuid,
  p_public boolean,
  p_expires_at timestamptz default null,
  p_password text default null,
  p_clear_password boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if auth.uid() is null then
    return false;
  end if;
  if p_password is not null and char_length(p_password) not between 4 and 128 then
    raise exception 'Share passwords must be 4 to 128 characters';
  end if;
  update public.notes x set
    is_public = p_public,
    share_expires_at = case when p_public then p_expires_at else null end,
    share_password_hash = case
      when not p_public or p_clear_password then null
      when p_password is not null then extensions.crypt(p_password, extensions.gen_salt('bf', 10))
      else x.share_password_hash
    end
  where x.id = p_note_id and x.user_id = auth.uid();
  return found;
end;
$$;

revoke all on function public.set_note_sharing(uuid, boolean, timestamptz, text, boolean) from public;
revoke execute on function public.set_note_sharing(uuid, boolean, timestamptz, text, boolean) from anon;
grant execute on function public.set_note_sharing(uuid, boolean, timestamptz, text, boolean) to authenticated;

-- Anyone with the link opens a shared note. Expired links return nothing.
-- Password-protected notes return only locked = true until the right password is given.
create or replace function public.open_shared_note(p_note_id uuid, p_password text default null)
returns table (id uuid, title text, type text, body text, tasks jsonb, updated_at timestamptz, locked boolean)
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  n public.notes%rowtype;
begin
  select * into n from public.notes x
  where x.id = p_note_id
    and x.is_public
    and (x.share_expires_at is null or x.share_expires_at > now());
  if not found then
    return;
  end if;
  if n.share_password_hash is not null
     and (p_password is null or extensions.crypt(p_password, n.share_password_hash) <> n.share_password_hash) then
    return query select n.id, null::text, null::text, null::text, null::jsonb, null::timestamptz, true;
    return;
  end if;
  return query select n.id, n.title, n.type, n.body, n.tasks, n.updated_at, false;
end;
$$;

revoke all on function public.open_shared_note(uuid, text) from public;
grant execute on function public.open_shared_note(uuid, text) to anon, authenticated;

-- Lets a signed-in person permanently delete their own account (privacy-law right to erasure).
-- notes and ai_usage reference auth.users with ON DELETE CASCADE, so their rows go too.
create or replace function public.delete_my_account()
returns boolean
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then
    return false;
  end if;
  delete from auth.users where id = uid;
  return found;
end;
$$;

revoke all on function public.delete_my_account() from public;
revoke execute on function public.delete_my_account() from anon;
grant execute on function public.delete_my_account() to authenticated;

-- v1 share function kept for older deployed copies: respects expiry and never reveals locked notes.
create or replace function public.get_shared_note(note_id uuid)
returns table (id uuid, title text, type text, body text, tasks jsonb, updated_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select n.id, n.title, n.type, n.body, n.tasks, n.updated_at
  from public.notes n
  where n.id = note_id
    and n.is_public
    and (n.share_expires_at is null or n.share_expires_at > now())
    and n.share_password_hash is null;
$$;
