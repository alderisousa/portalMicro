alter table public.businesses
  alter column template_key drop default,
  alter column template_key drop not null;

alter table public.businesses
  drop constraint if exists businesses_wizard_step_check;

alter table public.businesses
  add constraint businesses_wizard_step_check
  check (wizard_step between 0 and 6);
