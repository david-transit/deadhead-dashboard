-- Manual block edits: action "leg" = a different origin and/or destination for one empty leg between two trips
-- (payload: sched = the next trip's scheduled minute, a/frm = new origin, b/to = new destination). Only widens the
-- allowed actions: no existing row changes. Same table, RLS (editor+ writes), stamp and save_changes as the other edits.
alter table public.block_edits drop constraint block_edits_action_check;
alter table public.block_edits add constraint block_edits_action_check
  check (action in ('delete', 'replace', 'add', 'times', 'move', 'leg'));
