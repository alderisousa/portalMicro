export function normalizeSeoText(value?: string | null): string
export function createBusinessSeo(business: {
  name?: string | null
  category?: string | null
  story?: string | null
}): { title: string; description: string }
export function createCanonicalBusinessUrl(slug: string): string
