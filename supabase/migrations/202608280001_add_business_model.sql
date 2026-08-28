alter table public.businesses
  add column if not exists business_model text not null default 'services';

alter table public.businesses
  drop constraint if exists businesses_business_model_check;

alter table public.businesses
  add constraint businesses_business_model_check
  check (business_model in ('services', 'products', 'both'));
