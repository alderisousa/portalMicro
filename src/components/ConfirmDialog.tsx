import { useEffect, useId, useRef } from 'react'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  processingLabel: string
  processing: boolean
  previewUrl?: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  processingLabel,
  processing,
  previewUrl,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButton = useRef<HTMLButtonElement>(null)
  const processingRef = useRef(processing)
  const onCancelRef = useRef(onCancel)

  processingRef.current = processing
  onCancelRef.current = onCancel

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    cancelButton.current?.focus()

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !processingRef.current) {
        event.preventDefault()
        onCancelRef.current()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      previouslyFocused?.focus()
    }
  }, [])

  return (
    <div
      className="confirm-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !processing) onCancel()
      }}
    >
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        {previewUrl && (
          <img
            className="confirm-dialog-preview"
            src={previewUrl}
            alt="Foto selecionada para remoção"
          />
        )}

        <div className="confirm-dialog-content">
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
        </div>

        <div className="confirm-dialog-actions">
          <button
            ref={cancelButton}
            type="button"
            className="button button-outline"
            onClick={onCancel}
            disabled={processing}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="button button-destructive"
            onClick={onConfirm}
            disabled={processing}
          >
            {processing ? processingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
