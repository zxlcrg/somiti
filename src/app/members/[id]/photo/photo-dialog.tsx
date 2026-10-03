"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { removePhotoAction, uploadPhotoAction, type PhotoActionResult } from "./actions";

/** Size of the crop circle on screen, and of the saved square photo. */
const VIEW = 288;
const OUTPUT = 512;
const MAX_ZOOM = 4;

type Step = "choose" | "camera" | "crop";
type ErrorCode = Exclude<PhotoActionResult, { ok: true }>["error"] | "camera" | "unreadable";

interface Crop {
  /** Image position inside the circle, in screen pixels. */
  x: number;
  y: number;
  zoom: number;
}

/** Keeps the image covering the whole circle. */
function clamp(crop: Crop, img: { w: number; h: number }): Crop {
  const scale = (VIEW / Math.min(img.w, img.h)) * crop.zoom;
  const minX = VIEW - img.w * scale;
  const minY = VIEW - img.h * scale;
  return { zoom: crop.zoom, x: Math.min(0, Math.max(minX, crop.x)), y: Math.min(0, Math.max(minY, crop.y)) };
}

function centred(img: { w: number; h: number }, zoom = 1): Crop {
  const scale = (VIEW / Math.min(img.w, img.h)) * zoom;
  return { zoom, x: (VIEW - img.w * scale) / 2, y: (VIEW - img.h * scale) / 2 };
}

export function PhotoDialog({
  memberId,
  hasPhoto,
  trigger,
}: {
  memberId: string;
  hasPhoto: boolean;
  /** What the button shows: the current avatar. */
  trigger: React.ReactNode;
}) {
  const t = useTranslations("members.photo");
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const cameraInput = useRef<HTMLInputElement>(null);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);

  const [step, setStep] = useState<Step>("choose");
  const [source, setSource] = useState<{ url: string; w: number; h: number } | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, zoom: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const [cameraReady, setCameraReady] = useState(false);

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    setCameraReady(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  function reset() {
    stopCamera();
    if (source) URL.revokeObjectURL(source.url);
    setSource(null);
    setStep("choose");
    setError(null);
    setBusy(false);
  }

  function open() {
    reset();
    dialog.current?.showModal();
  }

  function close() {
    reset();
    dialog.current?.close();
  }

  function loadImage(blob: Blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const size = { w: img.naturalWidth, h: img.naturalHeight };
      if (source) URL.revokeObjectURL(source.url);
      setSource({ url, ...size });
      setCrop(centred(size));
      setStep("crop");
      setError(null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError("unreadable");
    };
    img.src = url;
  }

  async function startCamera() {
    setError(null);
    setStep("camera");
    try {
      stream.current = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } },
        audio: false,
      });
      if (video.current) {
        video.current.srcObject = stream.current;
        await video.current.play();
        setCameraReady(true);
      }
    } catch {
      stopCamera();
      setStep("choose");
      setError("camera");
    }
  }

  function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const g = canvas.getContext("2d")!;
    // Mirror back what the person saw in the preview.
    g.translate(canvas.width, 0);
    g.scale(-1, 1);
    g.drawImage(v, 0, 0);
    stopCamera();
    canvas.toBlob((blob) => (blob ? loadImage(blob) : setError("unreadable")), "image/jpeg", 0.95);
  }

  function setZoom(zoom: number) {
    if (!source) return;
    // Zoom around the centre of the circle.
    const oldScale = (VIEW / Math.min(source.w, source.h)) * crop.zoom;
    const newScale = (VIEW / Math.min(source.w, source.h)) * zoom;
    const cx = (VIEW / 2 - crop.x) / oldScale;
    const cy = (VIEW / 2 - crop.y) / oldScale;
    setCrop(clamp({ zoom, x: VIEW / 2 - cx * newScale, y: VIEW / 2 - cy * newScale }, source));
  }

  async function save() {
    if (!source) return;
    setBusy(true);
    setError(null);
    const img = new Image();
    img.src = source.url;
    await img.decode();
    const scale = (VIEW / Math.min(source.w, source.h)) * crop.zoom;
    const canvas = document.createElement("canvas");
    canvas.width = OUTPUT;
    canvas.height = OUTPUT;
    const g = canvas.getContext("2d")!;
    g.imageSmoothingQuality = "high";
    g.drawImage(img, -crop.x / scale, -crop.y / scale, VIEW / scale, VIEW / scale, 0, 0, OUTPUT, OUTPUT);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob) {
      setBusy(false);
      setError("unreadable");
      return;
    }
    const form = new FormData();
    form.set("photo", new File([blob], "photo.jpg", { type: "image/jpeg" }));
    const result = await uploadPhotoAction(memberId, form);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    close();
    router.refresh();
  }

  async function remove() {
    if (!window.confirm(t("removeConfirm"))) return;
    setBusy(true);
    const result = await removePhotoAction(memberId);
    if (!result.ok) {
      setBusy(false);
      setError(result.error);
      return;
    }
    close();
    router.refresh();
  }

  const scale = source ? (VIEW / Math.min(source.w, source.h)) * crop.zoom : 1;

  return (
    <>
      <button type="button" className="photo-trigger" onClick={open} aria-label={hasPhoto ? t("change") : t("add")}>
        {trigger}
        <span className="photo-trigger-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path
              d="M4 8h3l2-3h6l2 3h3v11H4zM12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
          </svg>
        </span>
      </button>

      <dialog ref={dialog} className="photo-dialog" onClose={reset} aria-labelledby="photo-dialog-title">
        <header>
          <h2 id="photo-dialog-title">{t("title")}</h2>
          <button type="button" className="icon-close" onClick={close} aria-label={t("close")}>
            ×
          </button>
        </header>

        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadImage(file);
            e.target.value = "";
          }}
        />
        <input
          ref={cameraInput}
          type="file"
          accept="image/*"
          capture="user"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) loadImage(file);
            e.target.value = "";
          }}
        />

        {step === "choose" && (
          <div className="photo-step">
            <div className="photo-stage idle">{trigger}</div>
            <p className="muted">{t("hint")}</p>
            <div className="photo-actions">
              <button
                type="button"
                className="btn primary"
                onClick={() =>
                  // Phones open their own camera app; computers get a live preview here.
                  window.matchMedia("(pointer: coarse)").matches || !navigator.mediaDevices?.getUserMedia
                    ? cameraInput.current?.click()
                    : startCamera()
                }
              >
                📷 {t("takePhoto")}
              </button>
              <button type="button" className="btn ghost" onClick={() => fileInput.current?.click()}>
                ⬆ {t("upload")}
              </button>
            </div>
            {hasPhoto && (
              <button type="button" className="link danger" onClick={remove} disabled={busy}>
                {t("remove")}
              </button>
            )}
          </div>
        )}

        {step === "camera" && (
          <div className="photo-step">
            <div className="photo-stage camera">
              <video ref={video} playsInline muted />
              {!cameraReady && <span className="photo-stage-note">{t("cameraStarting")}</span>}
            </div>
            <div className="photo-actions">
              <button type="button" className="btn ghost" onClick={reset}>
                {t("back")}
              </button>
              <button type="button" className="btn primary shutter" onClick={capture} disabled={!cameraReady}>
                ● {t("capture")}
              </button>
            </div>
          </div>
        )}

        {step === "crop" && source && (
          <div className="photo-step">
            <div
              className="photo-stage crop"
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                drag.current = { x: e.clientX, y: e.clientY, crop };
              }}
              onPointerMove={(e) => {
                if (!drag.current) return;
                const start = drag.current;
                setCrop(clamp({ ...start.crop, x: start.crop.x + e.clientX - start.x, y: start.crop.y + e.clientY - start.y }, source));
              }}
              onPointerUp={() => (drag.current = null)}
              onPointerCancel={() => (drag.current = null)}
              onWheel={(e) => setZoom(Math.min(MAX_ZOOM, Math.max(1, crop.zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08))))}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- a local preview of the picked file */}
              <img
                src={source.url}
                alt=""
                draggable={false}
                style={{ width: source.w * scale, height: source.h * scale, transform: `translate(${crop.x}px, ${crop.y}px)` }}
              />
            </div>
            <p className="muted small">{t("cropHint")}</p>
            <label className="zoom-row">
              <span>{t("zoom")}</span>
              <input
                type="range"
                className="slider"
                min={1}
                max={MAX_ZOOM}
                step={0.01}
                value={crop.zoom}
                onChange={(e) => setZoom(Number(e.target.value))}
                style={{ "--fill": `${((crop.zoom - 1) / (MAX_ZOOM - 1)) * 100}%` } as React.CSSProperties}
              />
            </label>
            <div className="photo-actions">
              <button type="button" className="btn ghost" onClick={reset} disabled={busy}>
                {t("retake")}
              </button>
              <button type="button" className="btn primary" onClick={save} disabled={busy}>
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden="true" /> {t("saving")}
                  </>
                ) : (
                  t("save")
                )}
              </button>
            </div>
          </div>
        )}

        {error && (
          <p className="form-error" role="alert">
            {t(`errors.${error}`)}
          </p>
        )}
      </dialog>
    </>
  );
}
