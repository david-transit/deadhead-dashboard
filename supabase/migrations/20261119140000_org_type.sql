-- operators.org_type (yalla-sa): the kind of organization, shown in the control panel's "שיוך ארגוני" column next to
-- its name. Free text set here (settings), not in code: today "מפעיל"; later e.g. "משרד ממשלתי", "חברת תכנון".
-- Additive only; null = no type shown. Read through the existing operators policies.
alter table public.operators add column org_type text check (org_type is null or length(org_type) between 1 and 40);
update public.operators set org_type = 'מפעיל' where slug = 'derech-egged';
