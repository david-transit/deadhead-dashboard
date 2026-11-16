-- Approved bus-only links ("נקודות מעבר מאושרות"): a road piece buses may use although the public OSRM car profile
-- does not (bus gate, bus-only direction). Route = OSRM to the entry point + the link + OSRM from the exit point.
-- Per operator. An editor may propose / change / delete an unapproved link; only a platform admin approves, and only
-- approved links are used for routing (assets/route.js smartLinks, assets/app.js). Changing an approved link's
-- geometry clears its approval unless a platform admin makes the change. No existing row is changed.
create table if not exists public.via_links (
  id uuid primary key default gen_random_uuid(),
  operator_id uuid not null references public.operators (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  a_lat numeric(9,6) not null check (a_lat between 29 and 34), a_lon numeric(9,6) not null check (a_lon between 34 and 36.5),
  b_lat numeric(9,6) not null check (b_lat between 29 and 34), b_lon numeric(9,6) not null check (b_lon between 34 and 36.5),
  link_km numeric(6,3) not null check (link_km > 0 and link_km <= 20),
  both_ways boolean not null default false,
  note text check (char_length(note) <= 300),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  approved_by uuid,
  approved_name text,
  approved_at timestamptz
);
create index if not exists via_links_operator on public.via_links (operator_id);
alter table public.via_links enable row level security;

create or replace function private.guard_via_link() returns trigger language plpgsql security definer set search_path = '' as $$
declare admin boolean := private.is_platform_admin();
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_at := now();
  else
    new.created_by := old.created_by; new.created_at := old.created_at; new.operator_id := old.operator_id;
  end if;
  if new.approved_at is not null and (tg_op = 'INSERT' or old.approved_at is null) then      -- approving
    if not admin then raise exception 'not_allowed'; end if;
    new.approved_by := auth.uid(); new.approved_at := now();
    new.approved_name := (select coalesce(nullif(p.display_name, ''), p.username) from public.profiles p where p.user_id = auth.uid());
  elsif tg_op = 'UPDATE' and old.approved_at is not null then
    if (new.a_lat, new.a_lon, new.b_lat, new.b_lon, new.link_km, new.both_ways) is distinct from
       (old.a_lat, old.a_lon, old.b_lat, old.b_lon, old.link_km, old.both_ways) and not admin then
      new.approved_by := null; new.approved_name := null; new.approved_at := null;            -- changed: needs approval again
    elsif new.approved_at is null and not admin then raise exception 'not_allowed';             -- only an admin withdraws approval
    elsif new.approved_at is not null then
      new.approved_by := old.approved_by; new.approved_name := old.approved_name; new.approved_at := old.approved_at;
    end if;
  else
    new.approved_by := null; new.approved_name := null; new.approved_at := null;
  end if;
  return new;
end $$;
revoke all on function private.guard_via_link() from public, anon, authenticated;
drop trigger if exists guard_via_link on public.via_links;
create trigger guard_via_link before insert or update on public.via_links for each row execute function private.guard_via_link();

drop policy if exists via_links_read on public.via_links;
drop policy if exists via_links_insert on public.via_links;
drop policy if exists via_links_update on public.via_links;
drop policy if exists via_links_delete on public.via_links;
create policy via_links_read on public.via_links for select to authenticated using (private.has_role(operator_id, 'viewer'));
create policy via_links_insert on public.via_links for insert to authenticated with check (private.has_role(operator_id, 'editor'));
create policy via_links_update on public.via_links for update to authenticated
  using (private.has_role(operator_id, 'editor')) with check (private.has_role(operator_id, 'editor'));
create policy via_links_delete on public.via_links for delete to authenticated
  using (private.has_role(operator_id, 'editor') and (approved_at is null or private.is_platform_admin()));
revoke all on public.via_links from anon, authenticated;
grant select, insert, update, delete on public.via_links to authenticated;

-- Seed (run separately as SQL, 2026-11-16, with David's approval given in chat; session_replication_role=replica skips the
-- user-session guard): Derech Egged 'האיילות: מחלף בית חורון (443) ← אגן האיילות', 31.871098,35.134394 -> 31.865956,35.140284,
-- 1.194 km along OSM ways 1015330760 (oneway=-1), 424808014, 1015330762 (lift_gate access=no at 31.869024,35.141761), one way.
