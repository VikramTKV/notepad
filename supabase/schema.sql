-- Quillnote database schema for the Supabase "notepad" project.
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
  constraint notes_body_size   check (octet_length(body) <= 500000),
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
