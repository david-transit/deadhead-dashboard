-- via_links management is for the platform admin only. Every operator member still reads the APPROVED links (routing
-- needs them); a pending proposal is visible only to its proposer and the platform admin. An editor proposes (insert);
-- only the platform admin changes or deletes, except that the proposer may delete his own unapproved proposal.
drop policy if exists via_links_read on public.via_links;
drop policy if exists via_links_update on public.via_links;
drop policy if exists via_links_delete on public.via_links;
create policy via_links_read on public.via_links for select to authenticated
  using (private.has_role(operator_id, 'viewer') and (approved_at is not null or private.is_platform_admin() or created_by = (select auth.uid())));
create policy via_links_update on public.via_links for update to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
create policy via_links_delete on public.via_links for delete to authenticated
  using (private.is_platform_admin() or (private.has_role(operator_id, 'editor') and approved_at is null and created_by = (select auth.uid())));
