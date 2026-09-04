-- GiroMicro Market - corrige market_extract_presentation_tokens (migration 007):
-- \b tem semantica de JavaScript/PCRE, nao de POSIX/ARE (o dialeto de regex do
-- PostgreSQL) - no Postgres real, o limite de palavra correto e \y. Confirmado
-- no banco: a funcao retornava [] para "ACHOCO PO NESCAU 350G" e afins, entao
-- has_presentation_match/has_presentation_conflict nunca contribuiam ao score.
--
-- Migrations 004-007 ja aplicadas e imutaveis, NAO editadas aqui. Esta migration
-- so faz CREATE OR REPLACE de market_extract_presentation_tokens(text), trocando
-- \b por \y. Nenhuma outra funcao, RPC, score, poda, frontend ou scanner e
-- alterado.
begin;

create or replace function public.market_extract_presentation_tokens(p_text text)
returns text[]
language sql
immutable
as $$
    select coalesce(array_agg(distinct token), array[]::text[])
    from (
        select case upper(m[2])
            when 'KG' then 'G:' || round(replace(m[1], ',', '.')::numeric * 1000)::text
            when 'GR' then 'G:' || round(replace(m[1], ',', '.')::numeric)::text
            when 'G'  then 'G:' || round(replace(m[1], ',', '.')::numeric)::text
            when 'L'  then 'ML:' || round(replace(m[1], ',', '.')::numeric * 1000)::text
            when 'ML' then 'ML:' || round(replace(m[1], ',', '.')::numeric)::text
        end as token
        from regexp_matches(upper(coalesce(p_text, '')), '(\d+(?:[.,]\d+)?)\s*(ML|KG|GR|G|L)\y', 'g') as m
    ) tokens;
$$;

revoke all on function public.market_extract_presentation_tokens(text) from public, anon;
grant execute on function public.market_extract_presentation_tokens(text) to authenticated;

comment on function public.market_extract_presentation_tokens(text) is
    'Extrai tokens normalizados de peso/volume de um texto (350G, 1KG=1000G, 1L=1000ML, 500ML, 240GR). Usada so para ranking de sugestoes - nunca altera quantity/unit fiscais. Usa \y (limite de palavra POSIX/ARE), nao \b.';

commit;
