-- Fix of 20261123100000: inside the subquery an unqualified "name" resolved to public.operators.name, not the file's
-- path, so no viewer could read any file (found on the first real download with a viewer, 23.11). Same rule, qualified.
drop policy if exists operator_data_read on storage.objects;
create policy operator_data_read on storage.objects for select to authenticated
using (
  bucket_id = 'operator-data'
  and private.session_alive()
  and exists (select 1 from public.operators o
              where o.slug = (storage.foldername(storage.objects.name))[1] and private.has_role(o.id, 'viewer'))
);
