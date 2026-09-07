import { useState } from 'react'
import type { PurchaseOcrDocument } from '../types/purchaseOcr'
import { pdfStagingDocument } from '../utils/purchaseReview'
import { PurchaseStagingReview } from './PurchaseStagingReview'

export function PurchasePdfReview({ document, accountId, destinationStoreId, reference, pageCount, onImported }: {
  document: PurchaseOcrDocument; accountId: string; destinationStoreId: string; reference: string; pageCount: number; onImported: (id: string) => void;
}) {
  const [original] = useState(() => pdfStagingDocument(document))
  return <PurchaseStagingReview original={original} accountId={accountId} destinationStoreId={destinationStoreId}
    reference={reference} sourceType="pdf" pageCount={pageCount} onImported={onImported} />
}
