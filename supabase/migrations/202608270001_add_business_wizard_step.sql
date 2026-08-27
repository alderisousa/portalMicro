alter table public.businesses
  add column if not exists wizard_step smallint not null default 0;

alter table public.businesses
  drop constraint if exists businesses_wizard_step_check;

alter table public.businesses
  add constraint businesses_wizard_step_check
  check (wizard_step between 0 and 5);
