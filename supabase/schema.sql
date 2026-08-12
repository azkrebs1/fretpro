-- FretPro cloud saves.
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.
--
-- Sign-in is by username with no password, which the app asks for on purpose.
-- The consequence is unavoidable: anyone who knows a username can load and
-- overwrite that profile. What this schema does prevent is bulk access — the
-- table has row level security on with no policies, so the anon key cannot
-- read or write it directly at all. The only way in is the two functions
-- below, and both need an exact username. Nobody can list who exists or dump
-- everyone's rows.
--
-- Keep it to practice progress. Do not store anything private in it.

create table if not exists public.profiles (
  username    text primary key,
  state       jsonb       not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- RLS on, deliberately with no policies: this table is unreachable from the
-- client. The security definer functions below are the whole API surface.
alter table public.profiles enable row level security;

revoke all on table public.profiles from anon, authenticated;

-- Usernames: lowercase, 2-24 chars, letters/digits/underscore/hyphen.
create or replace function public.fretpro_normalize_username(p_username text)
returns text
language plpgsql
immutable
as $$
declare
  clean text;
begin
  clean := lower(btrim(coalesce(p_username, '')));
  if clean !~ '^[a-z0-9_-]{2,24}$' then
    raise exception 'Username must be 2-24 characters, using letters, numbers, hyphen or underscore.'
      using errcode = '22023';
  end if;
  return clean;
end;
$$;

-- Load a profile. Returns null when the name has never been used, which the
-- app treats as "new account, start from what is on this device".
create or replace function public.get_profile(p_username text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  clean  text;
  result jsonb;
begin
  clean := public.fretpro_normalize_username(p_username);

  select jsonb_build_object('username', username, 'state', state, 'updated_at', updated_at)
    into result
    from public.profiles
   where username = clean;

  return result;
end;
$$;

-- Create or overwrite a profile. Returns the new updated_at.
create or replace function public.save_profile(p_username text, p_state jsonb)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  clean   text;
  saved   timestamptz;
begin
  clean := public.fretpro_normalize_username(p_username);

  if p_state is null or jsonb_typeof(p_state) <> 'object' then
    raise exception 'Progress must be a JSON object.' using errcode = '22023';
  end if;

  -- A full profile is a few tens of KB; this is only here to stop abuse.
  if pg_column_size(p_state) > 1000000 then
    raise exception 'Progress is too large to save.' using errcode = '22023';
  end if;

  insert into public.profiles as p (username, state)
       values (clean, p_state)
  on conflict (username)
    do update set state = excluded.state, updated_at = now()
    returning p.updated_at into saved;

  return saved;
end;
$$;

-- The client may call these two functions and nothing else.
revoke all on function public.get_profile(text) from public;
revoke all on function public.save_profile(text, jsonb) from public;
grant execute on function public.get_profile(text) to anon, authenticated;
grant execute on function public.save_profile(text, jsonb) to anon, authenticated;
