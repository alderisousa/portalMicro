import type { Business } from '../types/business'

export const formatCep = (value: string) => {
  const digits = value.replace(/\D/g, '').slice(0, 8)

  return digits.length > 5
    ? `${digits.slice(0, 5)}-${digits.slice(5)}`
    : digits
}

export const formatAddress = (business: Business) =>
  [
    business.street,
    business.number && `Nº ${business.number}`,
    business.complement,
    business.neighborhood,
    business.city,
    business.cep && `CEP: ${formatCep(business.cep)}`,
  ]
    .filter(Boolean)
    .join(', ') || business.address
