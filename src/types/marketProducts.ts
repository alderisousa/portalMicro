export interface MarketDuplicateProduct {
  id: string
  description: string
  ean: string
}

export interface MarketDuplicateGroup {
  description: string
  products: MarketDuplicateProduct[]
}

export interface MarketProductReadRow {
  id: string
  description: string | null
  ean: string | null
}
