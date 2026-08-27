alter table public.businesses
  add column if not exists template_key text not null default 'essential';

alter table public.businesses
  drop constraint if exists businesses_template_key_check;

alter table public.businesses
  add constraint businesses_template_key_check
  check (template_key in ('essential', 'featured'));
