"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Card, Notice, ui } from "@/components/ui";
import type { ClockBoardEmployee, ClockStatus } from "@/lib/payroll/clock";

/**
 * The shared clock-in device at the shop (RS5): tap your name, type your
 * PIN, then clock in or out or start or end a break. Nobody is signed in
 * here; the device was set up by someone with payroll access.
 */

type Board = { deviceName: string; employees: ClockBoardEmployee[] };

const STATUS_TEXT: Record<ClockStatus, string> = { out: "Out", in: "In", on_break: "On a break" };

const ACTIONS: Record<ClockStatus, Array<{ action: string; label: string }>> = {
  out: [{ action: "in", label: "Clock in" }],
  in: [
    { action: "break_start", label: "Start break" },
    { action: "out", label: "Clock out" },
  ],
  on_break: [{ action: "break_end", label: "End break" }],
};

async function call<T>(method: "GET" | "POST", body?: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const response = await fetch("/api/clock", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string };
  return { ok: response.ok, status: response.status, data };
}

function timeOf(value: string): string {
  return new Date(value).toLocaleTimeString("en-NZ", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Pacific/Auckland" });
}

export function ClockDevice() {
  const [board, setBoard] = useState<Board | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [chosen, setChosen] = useState<ClockBoardEmployee | null>(null);
  const [pin, setPin] = useState("");
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      void call<Board>("GET").then((result) => {
        if (!alive) return;
        if (result.ok) {
          setBoard(result.data);
          setProblem(null);
        } else setProblem(result.data.error ?? "Couldn't reach Tohyee.");
      });
    tick();
    const timer = setInterval(tick, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [refresh]);

  const done = (tone: "success" | "error", text: string) => {
    setMessage({ tone, text });
    if (reset.current) clearTimeout(reset.current);
    reset.current = setTimeout(() => setMessage(null), 6000);
  };

  const punch = async (action: string) => {
    if (!chosen) return;
    setBusy(true);
    const result = await call<{ message: string }>("POST", { employeeId: chosen.employeeId, pin, action });
    setBusy(false);
    setPin("");
    if (result.ok) {
      setChosen(null);
      done("success", result.data.message);
      setRefresh((value) => value + 1);
    } else done("error", result.data.error ?? "That didn't work.");
  };

  if (problem) return <Notice tone="error">{problem}</Notice>;
  if (!board) return <p className={ui.muted}>Loading…</p>;

  return (
    <>
      {message ? <Notice tone={message.tone}>{message.text}</Notice> : null}
      {chosen ? (
        <Card title={chosen.name} description={`${STATUS_TEXT[chosen.status]}${chosen.since ? ` since ${timeOf(chosen.since)}` : ""}. Type your PIN.`}>
          <input
            aria-label="PIN"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
            style={{ fontSize: 28, letterSpacing: 8, width: "100%", maxWidth: 260, padding: "8px 12px", marginBottom: 12 }}
            autoFocus
          />
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 72px)", gap: 8, marginBottom: 16 }}>
            {["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "⌫"].map((key) =>
              key === "" ? (
                <span key="blank" />
              ) : (
                <Button
                  key={key}
                  variant="secondary"
                  onClick={() => setPin(key === "⌫" ? pin.slice(0, -1) : (pin + key).slice(0, 8))}
                  aria-label={key === "⌫" ? "Delete" : key}
                >
                  <span style={{ fontSize: 22 }}>{key}</span>
                </Button>
              ),
            )}
          </div>
          <div className={ui.actions}>
            {ACTIONS[chosen.status].map((each) => (
              <Button key={each.action} onClick={() => void punch(each.action)} disabled={busy || pin.length < 4}>
                {each.label}
              </Button>
            ))}
            <Button variant="secondary" onClick={() => (setChosen(null), setPin(""))} disabled={busy}>
              Back
            </Button>
          </div>
        </Card>
      ) : (
        <Card title="Who are you?" description={`Clocking in on ${board.deviceName}. Tap your name.`}>
          {board.employees.length === 0 ? <p className={ui.muted}>No one has a clock-in PIN yet. Set them under Payroll &gt; Clock-ins.</p> : null}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12 }}>
            {board.employees.map((employee) => (
              <button
                key={employee.employeeId}
                type="button"
                className={`${ui.button} ${ui.secondary}`}
                style={{ height: "auto", minHeight: 72, flexDirection: "column", alignItems: "flex-start", padding: "12px 14px" }}
                onClick={() => {
                  setChosen(employee);
                  setPin("");
                  setMessage(null);
                }}
              >
                <strong>{employee.name}</strong>
                <span className={ui.muted}>
                  {STATUS_TEXT[employee.status]}
                  {employee.since ? ` since ${timeOf(employee.since)}` : ""}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
