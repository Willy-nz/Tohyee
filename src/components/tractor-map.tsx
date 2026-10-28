"use client";

import type { MultiPolygon } from "geojson";
import { useEffect, useRef, useState } from "react";
import type { TrackGap } from "@/lib/farming/coverage";
import { bounds, fitBox, linzAerialTileUrl, mapViewAt, type PaddockGeometry, type Position } from "@/lib/farming/geometry";
import styles from "./tractor.module.css";

/*
 * Tractor mode's map (#472 stage 5, decision 1024): north up, Web Mercator,
 * filling its box. Paddocks, the estimated worked footprint (green), overlap
 * (orange), not covered (pink outline), the travelled track (thin line),
 * gaps (red dashes), hazards and no-go zones (advisory), and where the phone
 * is with its accuracy circle. It follows the phone until someone drags it;
 * Recentre follows again.
 */

export type TractorMapHazard = { id: string; title: string; noGo: boolean; point: Position | null; ring: Position[] | null };

export type TractorMapProps = {
  label: string;
  paddocks: Array<{ id: string; name: string; geometry: PaddockGeometry | null; chosen: boolean }>;
  hazards?: TractorMapHazard[];
  footprint?: MultiPolygon | null;
  overlap?: MultiPolygon | null;
  missed?: MultiPolygon | null;
  /** The travelled track, one line per unbroken piece. */
  lines?: Position[][];
  /** Working stretches since the footprint was last worked out, drawn as wide lines. */
  recent?: Array<{ points: Position[]; widthM: number }>;
  gaps?: TrackGap[];
  position?: { lon: number; lat: number; acc: number | null; heading: number | null } | null;
  /** Follow the position (driving). */
  follow?: boolean;
  onFollowChange?: (follow: boolean) => void;
  imageryKey?: string | null;
  /** Big buttons for gloved hands. */
  large?: boolean;
};

const MAX_ZOOM = 21;
const MIN_ZOOM = 3;

function metresPerPixel(lat: number, zoom: number): number {
  return (156_543.033_92 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

function polygonsOf(multi: MultiPolygon | null | undefined): Position[][][] {
  return (multi?.coordinates ?? []) as Position[][][];
}

export function TractorMap(props: TractorMapProps) {
  const box = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 600, height: 400 });
  const [view, setView] = useState<{ centre: Position; zoom: number } | null>(null);
  const drag = useRef<{ x: number; y: number; centre: Position; moved: boolean } | null>(null);

  useEffect(() => {
    const element = box.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) setSize({ width: Math.round(rect.width), height: Math.round(rect.height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const chosen = props.paddocks.filter((paddock) => paddock.chosen && paddock.geometry).map((paddock) => paddock.geometry!);
  const trackShapes: PaddockGeometry[] = (props.lines ?? []).filter((line) => line.length > 1).map((line) => ({ type: "Polygon", coordinates: [[...line, line[0]]] }));
  const footprintShapes: PaddockGeometry[] = polygonsOf(props.footprint).map((polygon) => ({ type: "Polygon", coordinates: polygon }));
  const fitShapes = chosen.length ? chosen : [...footprintShapes, ...trackShapes, ...props.paddocks.filter((paddock) => paddock.geometry).map((paddock) => paddock.geometry!)];
  const fitted = (() => {
    const area = bounds(fitShapes);
    if (area) return fitBox(area, width, height, { pad: 24, maxZoom: 19 });
    if (props.position) return { centre: [props.position.lon, props.position.lat] as Position, zoom: 17 };
    return { centre: [172.6, -41.3] as Position, zoom: 5 };
  })();
  const zoom = view?.zoom ?? (props.follow && props.position ? Math.max(fitted.zoom, 17) : fitted.zoom);
  const centre: Position = props.follow && props.position ? [props.position.lon, props.position.lat] : (view?.centre ?? fitted.centre);
  const map = mapViewAt(centre, zoom, width, height, { maxTileZoom: 19 });
  const mpp = metresPerPixel(centre[1], zoom);
  const path = (rings: Position[][]) => rings.map((ring) => `M${ring.map((point) => map.project(point).map((value) => value.toFixed(1)).join(",")).join("L")}Z`).join(" ");
  const line = (points: Position[]) => `M${points.map((point) => map.project(point).map((value) => value.toFixed(1)).join(",")).join("L")}`;
  const outlines = (geometry: PaddockGeometry) => (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates);

  const setZoom = (next: number) => setView({ centre, zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, next)) });
  const recentre = () => {
    setView(view ? { centre, zoom: view.zoom } : null);
    props.onFollowChange?.(true);
  };

  const position = props.position ? map.project([props.position.lon, props.position.lat]) : null;
  const accuracyRadius = props.position?.acc != null ? props.position.acc / mpp : 0;

  return (
    <div ref={box} className={styles.mapBox}>
      <svg
        className={styles.map}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={props.label}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, centre, moved: false };
          (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || event.buttons === 0) return;
          const dx = event.clientX - drag.current.x;
          const dy = event.clientY - drag.current.y;
          if (!drag.current.moved && Math.hypot(dx, dy) < 6) return;
          drag.current.moved = true;
          const start = mapViewAt(drag.current.centre, zoom, width, height);
          setView({ centre: start.unproject([width / 2 - dx, height / 2 - dy]), zoom });
          if (props.follow) props.onFollowChange?.(false);
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onWheel={(event) => setZoom(zoom + (event.deltaY < 0 ? 0.5 : -0.5))}
      >
        <rect width={width} height={height} fill="var(--tractor-map-bg)" />
        {props.imageryKey
          ? map.tiles.map((tile) => <image key={`${tile.z}/${tile.x}/${tile.y}`} href={linzAerialTileUrl(tile, props.imageryKey!)} x={tile.left} y={tile.top} width={tile.size + 0.5} height={tile.size + 0.5} preserveAspectRatio="none" />)
          : null}
        {props.paddocks.map((paddock) =>
          paddock.geometry ? (
            <path
              key={paddock.id}
              d={path(outlines(paddock.geometry).flat())}
              fill={paddock.chosen ? "rgba(255, 255, 255, 0.12)" : "none"}
              stroke="var(--tractor-paddock)"
              strokeWidth={paddock.chosen ? 3 : 1.5}
              strokeDasharray={paddock.chosen ? undefined : "4 4"}
              fillRule="evenodd"
            />
          ) : null,
        )}
        {props.missed ? <path d={path(polygonsOf(props.missed).flat())} fill="none" stroke="var(--tractor-missed)" strokeWidth={2} strokeDasharray="6 3" fillRule="evenodd" /> : null}
        <path d={path(polygonsOf(props.footprint).flat())} fill="var(--tractor-worked)" fillOpacity={0.55} stroke="var(--tractor-worked)" strokeWidth={1} fillRule="evenodd" />
        {props.recent?.length ? (
          <g opacity={0.55}>
            {props.recent.map((stretch, index) => (stretch.points.length > 1 ? <path key={index} d={line(stretch.points)} fill="none" stroke="var(--tractor-worked)" strokeWidth={Math.max(2, stretch.widthM / mpp)} strokeLinejoin="round" strokeLinecap="butt" /> : null))}
          </g>
        ) : null}
        <path d={path(polygonsOf(props.overlap).flat())} fill="var(--tractor-overlap)" fillOpacity={0.75} stroke="none" fillRule="evenodd" />
        {(props.lines ?? []).map((points, index) => (points.length > 1 ? <path key={index} d={line(points)} fill="none" stroke="var(--tractor-track)" strokeWidth={1.5} /> : null))}
        {(props.gaps ?? []).map((gap, index) => (
          <path key={index} d={line([gap.from, gap.to])} fill="none" stroke="var(--tractor-gap)" strokeWidth={2.5} strokeDasharray="5 5">
            <title>{`Gap: ${gap.reason.replace("_", " ")}, ${Math.round(gap.seconds)} s`}</title>
          </path>
        ))}
        {(props.hazards ?? []).map((hazard) => (
          <g key={hazard.id}>
            {hazard.ring && hazard.ring.length > 3 ? <path d={path([hazard.ring])} fill={hazard.noGo ? "rgba(200, 30, 30, 0.3)" : "rgba(230, 150, 0, 0.25)"} stroke={hazard.noGo ? "#c81e1e" : "#b86e00"} strokeWidth={2} strokeDasharray="6 4" /> : null}
            {hazard.point
              ? (() => {
                  const [x, y] = map.project(hazard.point);
                  return <path d={`M${x},${y - 11}L${x + 10},${y + 7}L${x - 10},${y + 7}Z`} fill={hazard.noGo ? "#c81e1e" : "#e8a300"} stroke="#fff" strokeWidth={1.5} />;
                })()
              : null}
            <title>{`${hazard.noGo ? "No-go: " : "Hazard: "}${hazard.title}`}</title>
          </g>
        ))}
        {position ? (
          <g>
            {accuracyRadius > 2 ? <circle cx={position[0]} cy={position[1]} r={accuracyRadius} fill="rgba(28, 110, 220, 0.15)" stroke="rgba(28, 110, 220, 0.7)" strokeWidth={1} /> : null}
            {props.position?.heading != null && Number.isFinite(props.position.heading) ? (
              <path d="M0,-16 L10,10 L0,4 L-10,10 Z" transform={`translate(${position[0]},${position[1]}) rotate(${props.position.heading})`} fill="#1c6edc" stroke="#fff" strokeWidth={2} />
            ) : (
              <circle cx={position[0]} cy={position[1]} r={8} fill="#1c6edc" stroke="#fff" strokeWidth={3} />
            )}
          </g>
        ) : null}
      </svg>
      <div className={`${styles.mapControls} ${props.large ? styles.mapControlsLarge : ""}`}>
        <button type="button" onClick={() => setZoom(zoom + 1)} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={() => setZoom(zoom - 1)} aria-label="Zoom out">
          −
        </button>
        {props.onFollowChange ? (
          <button type="button" onClick={recentre} aria-pressed={props.follow} aria-label={props.follow ? "Following the tractor" : "Recentre on the tractor"}>
            {props.follow ? "◎" : "⌖"}
          </button>
        ) : null}
        <span className={styles.northUp} aria-label="North is up">
          N↑
        </span>
      </div>
      <div className={styles.scale} aria-hidden="true">
        {(() => {
          const target = mpp * 80;
          const nice = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].find((value) => value >= target * 0.6) ?? 5000;
          return (
            <>
              <span style={{ width: nice / mpp }} />
              {nice >= 1000 ? `${nice / 1000} km` : `${nice} m`}
            </>
          );
        })()}
      </div>
    </div>
  );
}

export function TractorLegend({ withPaddocks }: { withPaddocks: boolean }) {
  return (
    <ul className={styles.legend} aria-label="Map key">
      <li>
        <span style={{ background: "var(--tractor-worked)" }} /> Worked (estimate)
      </li>
      <li>
        <span style={{ background: "var(--tractor-overlap)" }} /> Overlap
      </li>
      {withPaddocks ? (
        <li>
          <span className={styles.legendDashed} style={{ borderColor: "var(--tractor-missed)" }} /> Not covered
        </li>
      ) : null}
      <li>
        <span className={styles.legendLine} style={{ background: "var(--tractor-track)" }} /> Track
      </li>
      <li>
        <span className={styles.legendDashed} style={{ borderColor: "var(--tractor-gap)" }} /> Gap (GPS weak, lost or not recording)
      </li>
    </ul>
  );
}
