"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Button, Field } from "@/components/ui";
import { CONSENT_TEXT, type SignatureMethod } from "@/lib/signing/shared";
import styles from "./signing.module.css";

export type SignatureValue = { method: SignatureMethod; typedName: string; signaturePng: string | null; consent: boolean };

/**
 * A drawn signature (decision 1400): mouse, pen or finger on a canvas.
 * Drawing needs a pointer, so the box says so and the form offers typing
 * the name instead, which works with a keyboard and a screen reader.
 */
function SignaturePad({ onChange, label }: { onChange: (png: string | null) => void; label: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  // Strokes as fractions of the box, so a resize (a phone's address bar hiding, or turning it round) redraws them rather than losing them.
  const strokes = useRef<Array<Array<{ x: number; y: number }>>>([]);
  const size = useRef({ width: 0, height: 0 });

  const paint = useCallback(() => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (!element || !context) return;
    const { width, height } = size.current;
    context.clearRect(0, 0, width, height);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = 2.4;
    context.strokeStyle = getComputedStyle(element).getPropertyValue("--signature-ink").trim() || "#14213d";
    for (const stroke of strokes.current) {
      context.beginPath();
      stroke.forEach((point, index) => (index === 0 ? context.moveTo(point.x * width, point.y * height) : context.lineTo(point.x * width, point.y * height)));
      if (stroke.length === 1) context.lineTo(stroke[0].x * width + 0.5, stroke[0].y * height);
      context.stroke();
    }
  }, []);

  const fit = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    if (Math.round(box.width) === size.current.width && Math.round(box.height) === size.current.height) return;
    const ratio = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
    size.current = { width: Math.round(box.width), height: Math.round(box.height) };
    element.width = Math.round(box.width * ratio);
    element.height = Math.round(box.height * ratio);
    element.getContext("2d")?.setTransform(ratio, 0, 0, ratio, 0, 0);
    paint();
  }, [paint]);

  const clear = () => {
    strokes.current = [];
    paint();
    onChange(null);
  };

  useEffect(() => {
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [fit]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };

  const down = (event: React.PointerEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    strokes.current.push([point(event)]);
    paint();
  };

  const move = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    strokes.current.at(-1)?.push(point(event));
    paint();
  };

  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    if (strokes.current.length && canvas.current) onChange(canvas.current.toDataURL("image/png"));
  };

  return (
    <div className={styles.stack} style={{ gap: 8 }}>
      <div className={styles.pad}>
        <canvas ref={canvas} role="img" aria-label={label} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
        <span className={styles.padLine} aria-hidden="true" />
        <span className={styles.padHint} aria-hidden="true">
          Sign above the line
        </span>
      </div>
      <div className={styles.actions}>
        <Button variant="secondary" size="small" onClick={clear}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** The signing part of a page: name, typed or drawn, the consent tick, and the Sign button. */
export function SignatureForm({
  defaultName,
  busy,
  submitLabel = "Sign",
  onSubmit,
}: {
  defaultName: string;
  busy: boolean;
  submitLabel?: string;
  onSubmit: (value: SignatureValue) => void;
}) {
  const id = useId();
  const [method, setMethod] = useState<SignatureMethod>("typed");
  const [typedName, setTypedName] = useState(defaultName);
  const [png, setPng] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const ready = typedName.trim().length > 0 && consent && (method === "typed" || png !== null);
  const onPng = useCallback((value: string | null) => setPng(value), []);

  return (
    <form
      className={styles.stack}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSubmit({ method, typedName: typedName.trim(), signaturePng: method === "drawn" ? png : null, consent });
      }}
    >
      <Field label="Your full name">
        <input value={typedName} onChange={(event) => setTypedName(event.target.value)} autoComplete="name" maxLength={150} required />
      </Field>
      <fieldset className={styles.methods}>
        <legend>How you sign</legend>
        <label>
          <input type="radio" name={`${id}-method`} checked={method === "typed"} onChange={() => setMethod("typed")} />
          Type my name
        </label>
        <label>
          <input type="radio" name={`${id}-method`} checked={method === "drawn"} onChange={() => setMethod("drawn")} />
          Draw my signature
        </label>
      </fieldset>
      {method === "typed" ? (
        <div className={styles.typedPreview} aria-label="Your typed signature" role="img">
          {typedName.trim() || " "}
        </div>
      ) : (
        <SignaturePad onChange={onPng} label="Signature box: draw with a finger, pen or mouse. To use the keyboard, choose Type my name." />
      )}
      <label className={styles.consent}>
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        {CONSENT_TEXT}
      </label>
      <div className={styles.actions}>
        <Button type="submit" disabled={busy || !ready}>
          {busy ? "Signing…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}
