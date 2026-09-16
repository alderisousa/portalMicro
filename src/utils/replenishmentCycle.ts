export function replenishmentCycleError(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  const messages: Record<string, string> = {
    REPLENISHMENT_RELIABLE_SALES_DATE_UNAVAILABLE: 'Não foi possível determinar até qual data as vendas estão consolidadas.',
    REPLENISHMENT_ORDER_NO_CANDIDATES: 'A nova análise não encontrou necessidades para gerar uma lista. A lista atual foi mantida.',
    REPLENISHMENT_FRESH_ANALYSIS_FAILED: 'Não foi possível gerar a nova análise. A lista atual foi mantida.',
    REPLENISHMENT_ORDER_ACTIVE_CONFLICT: 'Existe outro abastecimento em andamento. Atualize a tela.',
    REPLENISHMENT_CLOSURE_ORDER_INVALID: 'Esta lista não pode mais ser encerrada.',
    REPLENISHMENT_SUPPLY_BATCH_CONFLICT: 'A situação do abastecimento mudou desde a conferência. Atualize os dados e revise novamente.',
  }
  return Object.entries(messages).find(([code]) => message.includes(code))?.[1] ?? 'Não foi possível concluir a operação. Atualize e tente novamente.'
}
