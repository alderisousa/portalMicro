import { Camera, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

interface BarcodeScannerProps {
  onDetected: (code: string) => void
  onClose: () => void
}

export function BarcodeScanner({ onDetected, onClose }: BarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const controlsRef = useRef<{ stop: () => void } | null>(null)
  const detectedRef = useRef(false)
  const onDetectedRef = useRef(onDetected)
  const [error, setError] = useState('')

  useEffect(() => { onDetectedRef.current = onDetected }, [onDetected])

  const stopCamera = () => {
    controlsRef.current?.stop()
    controlsRef.current = null
    const stream = videoRef.current?.srcObject
    if (stream instanceof MediaStream) stream.getTracks().forEach((track) => track.stop())
    if (videoRef.current) videoRef.current.srcObject = null
  }

  useEffect(() => {
    let active = true

    const start = async () => {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setError('A câmera não está disponível neste navegador ou a página não está em uma conexão segura.')
        return
      }

      try {
        const { BrowserMultiFormatOneDReader } = await import('@zxing/browser')
        if (!active || !videoRef.current) return
        const reader = new BrowserMultiFormatOneDReader(undefined, {
          delayBetweenScanAttempts: 180,
          delayBetweenScanSuccess: 800,
        })
        const controls = await reader.decodeFromConstraints({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        }, videoRef.current, (result) => {
          if (!active || detectedRef.current || !result) return
          const code = result.getText().trim()
          if (!code) return
          detectedRef.current = true
          stopCamera()
          onDetectedRef.current(code)
        })
        if (!active) controls.stop()
        else controlsRef.current = controls
      } catch (cause) {
        if (!active) return
        const name = cause instanceof DOMException ? cause.name : ''
        setError(name === 'NotAllowedError' || name === 'SecurityError'
          ? 'Permissão para usar a câmera negada. Libere o acesso ou continue pela busca manual.'
          : name === 'NotFoundError' || name === 'DevicesNotFoundError'
            ? 'Nenhuma câmera foi encontrada neste dispositivo.'
            : name === 'NotReadableError' || name === 'TrackStartError'
              ? 'A câmera está indisponível ou sendo usada por outro aplicativo.'
              : 'Não foi possível iniciar a câmera. Feche o scanner e use a busca manual.')
      }
    }

    void start()
    return () => { active = false; stopCamera() }
  }, [])

  const close = () => { stopCamera(); onClose() }

  return <div className="barcode-scanner-backdrop" role="dialog" aria-modal="true" aria-label="Leitor de código de barras">
    <section className="barcode-scanner-panel">
      <header><div><span className="panel-kicker"><Camera size={15} /> CÂMERA</span><h2>Escanear código de barras</h2></div><button type="button" onClick={close} aria-label="Fechar scanner"><X /></button></header>
      <p>Aponte a câmera para o código de barras e mantenha o produto dentro da área destacada.</p>
      <div className="barcode-scanner-preview"><video ref={videoRef} autoPlay muted playsInline /><span aria-hidden="true" /></div>
      {error && <div className="admin-message is-error" role="alert">{error}</div>}
      <button className="button button-outline" type="button" onClick={close}>Fechar e buscar manualmente</button>
    </section>
  </div>
}
