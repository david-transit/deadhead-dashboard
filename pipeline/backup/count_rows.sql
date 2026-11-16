-- row count of every table in the backed-up schemas: "schema.table|count", sorted (used by backup-weekly.yml)
select n.nspname || '.' || c.relname,
       (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname), false, true, '')))[1]::text::bigint
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname in ('public', 'private', 'auth') and c.relkind in ('r', 'p')
order by 1;
