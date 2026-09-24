export const normalizeSeoText = (value) => (value ?? '').replace(/\s+/g, ' ').trim()

const titlePart = (value) => normalizeSeoText(value).replace(/^[\s|–—-]+|[\s|–—-]+$/g, '')

export const createBusinessSeo = ({ name, category, story }) => {
  const normalizedName = titlePart(name)
  const normalizedCategory = titlePart(category)
  const title = `${[normalizedName, normalizedCategory].filter(Boolean).join(' - ')} | GiroMicro`
  const source = normalizeSeoText(story) || (normalizedCategory
    ? `Conheça ${normalizedName}, ${normalizedCategory}, seus serviços e formas de contato no GiroMicro.`
    : `Conheça ${normalizedName} e suas formas de contato no GiroMicro.`)
  const characters = Array.from(source)
  const description = characters.length <= 160 ? source : `${characters.slice(0, 157).join('').trimEnd()}...`
  return { title, description }
}

export const createCanonicalBusinessUrl = (slug) =>
  `https://www.giromicro.com.br/negocio/${encodeURIComponent(slug)}`
