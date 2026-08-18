import type { FeatureCollection } from 'geojson';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef } from 'react';

/**
 * MapLibre rather than Google Maps.
 *
 * No API key, no billing account, no per-load quota — which matters for a local
 * console nobody wants to attach a credit card to. Raster tiles come from OSM,
 * whose usage policy is fine for a single developer machine but would need a
 * proper tile provider before this served a team.
 */

export interface MapLayer {
  id: string;
  /** Array of [lon, lat] rings — one entry per separate line. */
  lines: number[][][];
  colour: string;
  width?: number;
  dashed?: boolean;
}

export interface MapPin {
  id: string;
  lon: number;
  lat: number;
  colour: string;
  /** Diameter in px. Bigger means more urgent — default 16. */
  size?: number;
  /** Draws attention — used for overdue work. */
  pulse?: boolean;
  /** Popup body. Caller is responsible for escaping. */
  html?: string;
  onClick?: () => void;
}

const OSM_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
};

export default function DrainMap({
  layers,
  pins = [],
  fitTo,
  height = '100%',
}: {
  layers: MapLayer[];
  pins?: MapPin[];
  /** [lon, lat] pairs to frame on load. */
  fitTo?: number[][];
  height?: string | number;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const markers = useRef<maplibregl.Marker[]>([]);
  const popup = useRef<maplibregl.Popup | null>(null);
  const ready = useRef(false);
  const fitted = useRef(false);

  useEffect(() => {
    if (!container.current || map.current) return;

    map.current = new maplibregl.Map({
      container: container.current,
      style: OSM_STYLE,
      center: [103.83, 1.35],
      zoom: 11,
    });
    map.current.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.current.on('load', () => {
      ready.current = true;
      sync();
    });

    popup.current = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      offset: 14,
      maxWidth: '280px',
    });

    /**
     * MapLibre sizes its canvas once and does not watch the container.
     * Without this the map keeps its original dimensions when the window is
     * resized or the browser moves to a different monitor — the symptom being a
     * map that refuses to fill its panel.
     */
    const ro = new ResizeObserver(() => map.current?.resize());
    ro.observe(container.current);

    return () => {
      ro.disconnect();
      popup.current?.remove();
      map.current?.remove();
      map.current = null;
      ready.current = false;
      fitted.current = false;
    };
  }, []);

  function sync() {
    const m = map.current;
    if (!m || !ready.current) return;

    // Remove layers we no longer render. MapLibre throws if a source is removed
    // while a layer still references it, so always drop the layer first.
    const keep = new Set(layers.map((l) => l.id));
    for (const layer of m.getStyle().layers ?? []) {
      if (layer.id.startsWith('dl-') && !keep.has(layer.id.slice(3))) {
        if (m.getLayer(layer.id)) m.removeLayer(layer.id);
        if (m.getSource(layer.id)) m.removeSource(layer.id);
      }
    }

    for (const l of layers) {
      const id = `dl-${l.id}`;
      const data: FeatureCollection = {
        type: 'FeatureCollection',
        features: l.lines
          .filter((line) => line.length >= 2)
          .map((line) => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'LineString', coordinates: line },
          })),
      };

      const src = m.getSource(id) as maplibregl.GeoJSONSource | undefined;
      if (src) {
        src.setData(data);
      } else {
        m.addSource(id, { type: 'geojson', data });
        m.addLayer({
          id,
          type: 'line',
          source: id,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': l.colour,
            'line-width': l.width ?? 4,
            ...(l.dashed ? { 'line-dasharray': [2, 2] as [number, number] } : {}),
          },
        });
      }
    }

    markers.current.forEach((mk) => mk.remove());
    markers.current = pins.map((pin) => {
      const el = document.createElement('div');
      el.className = `map-pin${pin.pulse ? ' pulse' : ''}`;
      el.style.background = pin.colour;
      const d = pin.size ?? 16;
      el.style.width = `${d}px`;
      el.style.height = `${d}px`;

      if (pin.html) {
        el.addEventListener('mouseenter', () => {
          popup.current?.setLngLat([pin.lon, pin.lat]).setHTML(pin.html!).addTo(m);
        });
        el.addEventListener('mouseleave', () => popup.current?.remove());
      }
      if (pin.onClick) {
        el.style.cursor = 'pointer';
        el.addEventListener('click', pin.onClick);
      }

      return new maplibregl.Marker({ element: el })
        .setLngLat([pin.lon, pin.lat])
        .addTo(m);
    });

    // Frame once. Re-fitting on every data change would fight the user every
    // time they zoomed in on something.
    if (fitTo && fitTo.length > 1 && !fitted.current) {
      fitted.current = true;
      const b = new maplibregl.LngLatBounds();
      for (const c of fitTo) b.extend(c as [number, number]);
      m.fitBounds(b, { padding: 60, maxZoom: 16, duration: 0 });
    }
  }

  useEffect(sync, [layers, pins, fitTo]);

  return <div ref={container} style={{ width: '100%', height }} />;
}
