import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'

interface ConfirmDialogProps {
  children?: ReactNode
  cancelLabel?: string
  confirmDisabled?: boolean
  cancelDisabled?: boolean
  className?: string
  trapFocus?: boolean
  title: string
  description: string
  confirmLabel: string
  processingLabel: string
  processing: boolean
  confirmVariant?: 'primary' | 'destructive'
  previewUrl?: string
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  children, cancelLabel = 'Cancelar', confirmDisabled = false, cancelDisabled = false, className = '', trapFocus = false,
  title,
  description,
  confirmLabel,
  processingLabel,
  processing,
  confirmVariant = 'destructive',
  previewUrl,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const processingRef = useRef(processing)
  const onCancelRef = useRef(onCancel)

  processingRef.current = processing
  onCancelRef.current = onCancel

  useEffect(() => {
    if (trapFocus && processing) dialog.current?.focus()
  }, [trapFocus, processing])

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
        className={`confirm-dialog ${className}`}
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        onKeyDown={event => {
          if (!trapFocus || event.key !== 'Tab') return
          const elements = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]'))
          const first = elements[0], last = elements[elements.length - 1]
          if (!first) { event.preventDefault(); event.currentTarget.focus(); return }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === event.currentTarget)) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }}
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
          {children}
        </div>

        <div className="confirm-dialog-actions">
          <button
            ref={cancelButton}
            type="button"
            className="button button-outline"
            onClick={onCancel}
            disabled={processing || cancelDisabled}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button${confirmVariant === 'destructive' ? ' button-destructive' : ''}`}
            onClick={onConfirm}
            disabled={processing || confirmDisabled}
          >
            {processing ? processingLabel : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
