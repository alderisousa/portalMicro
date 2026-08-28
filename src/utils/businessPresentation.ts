import type { Business, BusinessModel } from '../types/business'
import { formatCep } from './formatters'

export const getShowcaseCopy = (model: BusinessModel | null | undefined) => {
  if (model === 'products') {
    return {
      wizardTitle: 'Seus produtos',
      wizardDescription: 'Adicione produtos para apresentar aos seus clientes.',
      publicTitle: 'Nossos produtos',
    }
  }

  if (model === 'both') {
    return {
      wizardTitle: 'Sua vitrine',
      wizardDescription: 'Apresente seus principais produtos e serviços.',
      publicTitle: 'Produtos e serviços',
    }
  }

  return {
    wizardTitle: 'Seus serviços e trabalhos',
    wizardDescription: 'Mostre alguns serviços, projetos ou trabalhos realizados.',
    publicTitle: 'Conheça nosso trabalho',
  }
}

export const getAddressPresentation = (business: Business) => {
  const streetLine = [business.street, business.number].filter(Boolean).join(', ')
  const localityLine = [business.city, business.cep && `CEP ${formatCep(business.cep)}`]
    .filter(Boolean)
    .join(' · ')
  const lines = [streetLine, business.complement, business.neighborhood, localityLine]
    .filter((line): line is string => Boolean(line?.trim()))
  const queryParts = [
    business.street,
    business.number,
    business.complement,
    business.neighborhood,
    business.city,
    business.cep && formatCep(business.cep),
  ].filter(Boolean)

  return {
    lines,
    mapsUrl: queryParts.length >= 2
      ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(queryParts.join(', '))}`
      : '',
  }
}
