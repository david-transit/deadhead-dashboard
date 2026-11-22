-- Operator data out of the public repo (David 22.11, stage 2): the encrypted day / ends / days files of each operator
-- live in the private Storage bucket 'operator-data', path <operator slug>/<file>. Encryption stays as it is.
-- Read: a signed-in portal user with at least 'viewer' on that operator (same rule as the deadhead tables), live session.
-- Write: only the nightly pipeline with the service-role key (no insert/update/delete policy for users).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('operator-data', 'operator-data', false, 20971520, array['text/javascript'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists operator_data_read on storage.objects;
create policy operator_data_read on storage.objects for select to authenticated
using (
  bucket_id = 'operator-data'
  and private.session_alive()
  and exists (select 1 from public.operators o
              where o.slug = (storage.foldername(name))[1] and private.has_role(o.id, 'viewer'))
);
