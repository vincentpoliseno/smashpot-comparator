import { useState, useRef } from "react";

/*
  Smashpot V2 Dual-Rate Coil Comparator
  --------------------------------------
  Self-contained. No external UI libraries, no Tailwind, no browser storage.
  Renders in Claude and ports directly into a Vite/Vercel project or Lovable.

  Model (validated against Vorsprung's published 200mm chart):
    - Two springs in series until the secondary coil-binds, then the primary alone.
    - Initial rate (0 -> knee):   k_eff = (k_s * k_p) / (k_s + k_p)
    - Final rate  (knee -> end):  k_p
    - Knee force:                 F_knee = k_s * bindStroke      (set by secondary)
    - Knee travel:                bindStroke + F_knee / k_p       (set by both)
    - Bottom-out force:           F_knee + k_p * (travel - kneeTravel)   (spring only)
    - Sag: travel where spring force == staticLoad (= riderWeight * %onFork)

  Calibration: 120 lb/in secondary, 55 primary, 22mm bind -> knee 70mm / ~465N.
*/

const LBIN_TO_NMM = 4.44822 / 25.4; // 0.175127 N/mm per lbf/in
const KG_TO_N = 9.80665;
const LB_TO_N = 4.44822;
const N_TO_LBF = 0.224809;

const WIRE = ["#f2b705", "#e0507a", "#3aa0ff", "#46c46a"];

const SECONDARY_PRESETS = {
  "Old (120)": 120,
  "Pink (200)": 200,
  "Blue (300)": 300,
  Custom: null,
};

function computeSetup(s, g) {
  const ks = s.secondary;
  const kp = s.primary;
  const bind = s.bind;
  const travel = g.travel;

  const ks_n = ks * LBIN_TO_NMM;
  const kp_n = kp * LBIN_TO_NMM;

  const initial = (ks * kp) / (ks + kp);
  const keff_n = initial * LBIN_TO_NMM;

  const Fknee = ks_n * bind;
  const kneeTravel = bind + Fknee / kp_n;
  const kneeReached = kneeTravel <= travel;

  const final = kneeReached ? kp : initial;

  const springBottom = kneeReached
    ? Fknee + kp_n * (travel - kneeTravel)
    : keff_n * travel;

  const riderN = g.weightUnit === "kg" ? g.weight * KG_TO_N : g.weight * LB_TO_N;
  const staticN = (riderN * g.pct) / 100;

  let sag;
  if (staticN <= Fknee) sag = staticN / keff_n;
  else sag = kneeTravel + (staticN - Fknee) / kp_n;
  const staticBottom = sag > travel;
  sag = Math.min(sag, travel);

  return {
    initial,
    final,
    Fknee,
    kneeTravel,
    kneeReached,
    kneePct: (kneeTravel / travel) * 100,
    springBottom,
    bottom: springBottom,
    staticN,
    sag,
    sagPct: (sag / travel) * 100,
    staticBottom,
    _kp_n: kp_n,
    _keff_n: keff_n,
  };
}

function forceAt(t, r) {
  if (t <= r.kneeTravel) return r._keff_n * t;
  return r.Fknee + r._kp_n * (t - r.kneeTravel);
}
function travelAtForce(F, r) {
  if (F <= 0) return 0;
  if (F <= r.Fknee) return F / r._keff_n;
  return r.kneeTravel + (F - r.Fknee) / r._kp_n;
}
function gMarkers(r, travel) {
  if (r.staticN <= 0) return [];
  const maxF = forceAt(travel, r);
  const maxG = maxF / r.staticN;
  const markers = [];
  const maxIntG = Math.floor(maxG + 1e-9);
  const maxIsInteger = Math.abs(maxG - maxIntG) < 1e-6;

  for (let g = 2; g <= maxIntG; g++) {
    const force = r.staticN * g;
    const t = Math.min(travelAtForce(force, r), travel);
    const atMax = Math.abs(t - travel) < 1e-6;
    if (atMax && maxIsInteger && g === maxIntG) continue;
    markers.push({ label: `${g}g`, t, force });
  }

  markers.push({ label: `${maxG.toFixed(1)}g`, t: travel, force: maxF, isMax: true });
  return markers;
}

function gMarkerLabelPos(cx, cy, mk, mi, setupIdx, plotRight) {
  const nearRight = mk.isMax || cx > plotRight - 30;
  if (mk.isMax) {
    return {
      x: cx - 7,
      y: cy - 8 - setupIdx * 13,
      anchor: "end",
    };
  }
  const above = mi % 2 === 0;
  return {
    x: nearRight ? cx - 7 : cx + 6,
    y: cy + (above ? -7 : 12),
    anchor: nearRight ? "end" : "start",
  };
}
function rateAt(t, r) {
  if (!r.kneeReached) return r.initial;
  return t <= r.kneeTravel ? r.initial : r.final;
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function ticksFor(min, max, approx = 5) {
  const range = max - min;
  if (range <= 0) return [min];
  const rawStep = range / approx;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  const step = nice * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  if (min <= 0 && max >= 0 && !out.some((v) => Math.abs(v) < step * 1e-6)) out.push(0);
  return out.sort((a, b) => a - b);
}

export default function SmashpotComparator() {
  const [global, setGlobal] = useState({
    travel: 200,
    pct: 45,
    weight: 85,
    weightUnit: "kg",
  });
  const [yMode, setYMode] = useState("force"); // force | rate
  const [xRef, setXRef] = useState("top"); // top | sag

  const [setups, setSetups] = useState([
    { name: "Setup 1", preset: "Old (120)", secondary: 120, bind: 22, primary: 55 },
    { name: "Setup 2", preset: "Blue (300)", secondary: 300, bind: 22, primary: 60 },
  ]);

  const g = {
    travel: num(global.travel, 200),
    pct: num(global.pct, 45),
    weight: num(global.weight, 0),
    weightUnit: global.weightUnit,
  };

  const results = setups.map((s) =>
    computeSetup(
      { secondary: num(s.secondary, 1), bind: num(s.bind, 1), primary: num(s.primary, 1) },
      g
    )
  );

  const labels = setups.map((s) => `${num(s.secondary, 0)}-${num(s.primary, 0)}`);

  const setG = (k, v) => setGlobal((p) => ({ ...p, [k]: v }));
  const setS = (i, k, v) => setSetups((p) => p.map((s, idx) => (idx === i ? { ...s, [k]: v } : s)));
  function setPreset(i, preset) {
    setSetups((p) =>
      p.map((s, idx) => {
        if (idx !== i) return s;
        const rate = SECONDARY_PRESETS[preset];
        return { ...s, preset, secondary: rate === null ? s.secondary : rate };
      })
    );
  }
  function addSetup() {
    if (setups.length >= 4) return;
    setSetups((p) => [
      ...p,
      { name: `Setup ${p.length + 1}`, preset: "Old (120)", secondary: 120, bind: 22, primary: 60 },
    ]);
  }
  function removeSetup(i) {
    if (setups.length <= 1) return;
    setSetups((p) => p.filter((_, idx) => idx !== i));
  }

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      <header style={S.header}>
        <div style={S.eyebrow}>SMASHPOT V2 · DUAL-RATE COIL</div>
        <h1 style={S.h1}>Spring Setup Comparator</h1>
        <p style={S.sub}>
          Series-then-primary model with coil-bind knee. Set the rider and fork once, then
          compare spring combinations side by side.
        </p>
      </header>

      <section style={S.panel}>
        <div style={S.panelLabel}>Rider &amp; fork</div>
        <div style={S.globalGrid}>
          <Field label="Rider weight (kitted)">
            <div style={{ display: "flex", gap: 6 }}>
              <input className="in" style={{ ...S.input, flex: 1 }} type="number" value={global.weight}
                onChange={(e) => setG("weight", e.target.value)} />
              <div className="seg">
                {["kg", "lb"].map((u) => (
                  <button key={u} className={"segbtn" + (global.weightUnit === u ? " on" : "")}
                    onClick={() => setG("weightUnit", u)}>{u}</button>
                ))}
              </div>
            </div>
          </Field>
          <Field label="Weight on fork (%)" hint="≈45% static, attack position">
            <input className="in" style={S.input} type="number" value={global.pct}
              onChange={(e) => setG("pct", e.target.value)} />
          </Field>
          <Field label="Max travel (mm)">
            <input className="in" style={S.input} type="number" value={global.travel}
              onChange={(e) => setG("travel", e.target.value)} />
          </Field>
        </div>
      </section>

      <section style={S.panel}>
        <div style={S.panelHead}>
          <div style={S.panelLabel}>Spring setups</div>
          <button className="ghost" onClick={addSetup} disabled={setups.length >= 4}>+ Add setup</button>
        </div>
        <div style={S.setupRow}>
          {setups.map((s, i) => (
            <div key={i} style={{ ...S.setupCard, borderTopColor: WIRE[i] }}>
              <div style={S.setupHead}>
                <span style={{ ...S.dot, background: WIRE[i] }} />
                <span style={S.setupTitle}>{labels[i]}</span>
                {i === 0 && <span style={S.baseBadge}>base</span>}
                {setups.length > 1 && (
                  <button className="x" onClick={() => removeSetup(i)} title="Remove">×</button>
                )}
              </div>
              <Field label="Secondary (small) spring">
                <select className="in" style={S.input} value={s.preset}
                  onChange={(e) => setPreset(i, e.target.value)}>
                  {Object.keys(SECONDARY_PRESETS).map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
              <div style={S.pairRow}>
                <Field label="Secondary rate (lb/in)">
                  <input className="in" style={S.input} type="number" value={s.secondary}
                    disabled={s.preset !== "Custom"} onChange={(e) => setS(i, "secondary", e.target.value)} />
                </Field>
                <Field label="Bind stroke (mm)" hint="firmer binds earlier">
                  <input className="in" style={S.input} type="number" value={s.bind}
                    onChange={(e) => setS(i, "bind", e.target.value)} />
                </Field>
              </div>
              <Field label="Primary (large) spring (lb/in)">
                <input className="in" style={S.input} type="number" value={s.primary}
                  onChange={(e) => setS(i, "primary", e.target.value)} />
              </Field>
            </div>
          ))}
        </div>
      </section>

      <section style={S.panel}>
        <div style={S.panelHead}>
          <div style={S.panelLabel}>{yMode === "force" ? "Force" : "Rate"} vs travel</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <div className="seg">
              {[["force", "Force"], ["rate", "Rate"]].map(([v, l]) => (
                <button key={v} className={"segbtn" + (yMode === v ? " on" : "")} onClick={() => setYMode(v)}>{l}</button>
              ))}
            </div>
            <div className="seg">
              {[["top", "From top"], ["sag", "From sag"]].map(([v, l]) => (
                <button key={v} className={"segbtn" + (xRef === v ? " on" : "")} onClick={() => setXRef(v)}>{l}</button>
              ))}
            </div>
          </div>
        </div>
        <Plot results={results} g={g} yMode={yMode} xRef={xRef} labels={labels} />
        <div style={S.plotKey}>
          <span>× knee</span>
          <span style={{ marginLeft: 18 }}>● g markers (1g = static sag … max force)</span>
          {xRef === "sag" ? <span style={{ marginLeft: 18 }}>0 = ride height (sag); negative = toward top-out</span>
            : <span style={{ marginLeft: 18 }}>◇ static sag point</span>}
        </div>
      </section>

      <section style={S.panel}>
        <div style={S.panelLabel}>Results <span style={S.baseNote}>· % shown vs {labels[0]}</span></div>
        <div style={{ overflowX: "auto" }}>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{ ...S.th, textAlign: "left" }}>Metric</th>
                {setups.map((s, i) => (
                  <th key={i} style={S.th}>
                    <span style={{ ...S.dot, background: WIRE[i], marginRight: 6 }} />
                    {labels[i]}{i === 0 && <span style={S.baseBadgeSm}>base</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <Row label="Initial rate" unit="lb/in" raw={results.map((r) => r.initial)} fmt={(v) => v.toFixed(1)} />
              <Row label="Final rate" unit="lb/in" raw={results.map((r) => r.final)} fmt={(v) => v.toFixed(1)} />
              <Row label="Knee position" unit="mm"
                raw={results.map((r) => (r.kneeReached ? r.kneeTravel : null))}
                fmt={(v) => v.toFixed(0)}
                sub={results.map((r) => (r.kneeReached ? `${r.kneePct.toFixed(0)}% travel` : "not reached"))} />
              <Row label="Knee force" unit="N" raw={results.map((r) => r.Fknee)} fmt={(v) => v.toFixed(0)}
                sub={results.map((r) => `${(r.Fknee * N_TO_LBF).toFixed(0)} lbf`)} />
              <Row label="Bottom-out force" unit="N" raw={results.map((r) => r.bottom)} fmt={(v) => v.toFixed(0)}
                sub={results.map((r) => `${(r.bottom * N_TO_LBF).toFixed(0)} lbf`)} />
              <Row label="Sag" unit="mm" raw={results.map((r) => r.sag)} fmt={(v) => v.toFixed(0)}
                sub={results.map((r) => `${r.sagPct.toFixed(0)}%`)} highlight />
            </tbody>
          </table>
        </div>
        {results.some((r) => r.staticBottom || !r.kneeReached) && (
          <div style={S.warn}>
            {results.some((r) => r.staticBottom) && "· A setup sags past full travel — rider load exceeds the spring. "}
            {results.some((r) => !r.kneeReached) && "· A secondary doesn't bind within travel — soft series rate holds the whole stroke."}
          </div>
        )}
      </section>

      <footer style={S.footer}>
        Calibrated to the Vorsprung 200mm chart (120 lb/in secondary, 22mm bind → 70mm / 465N knee at
        55 primary). Bottom-out is spring force at full travel. Bind stroke defaults to 22mm — measure
        your pink/blue springs and override for exact knees.
      </footer>
    </div>
  );
}

function Plot({ results, g, yMode, xRef, labels }) {
  const [hover, setHover] = useState(null);
  const wrapRef = useRef(null);
  const W = 760, H = 380;
  const m = { t: 16, r: 16, b: 40, l: 58 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const travel = g.travel > 0 ? g.travel : 200;
  const shift = (r) => (xRef === "sag" ? r.sag : 0);

  // x domain
  let xMin, xMax;
  if (xRef === "sag") {
    xMin = Math.min(...results.map((r) => 0 - r.sag));
    xMax = Math.max(...results.map((r) => travel - r.sag));
  } else { xMin = 0; xMax = travel; }
  if (xMax - xMin < 1) xMax = xMin + 1;

  // y domain
  let yMax;
  if (yMode === "force") yMax = Math.ceil(Math.max(100, ...results.map((r) => r.springBottom)) / 200) * 200;
  else yMax = Math.ceil(Math.max(20, ...results.map((r) => r.final)) / 20) * 20;

  const x = (t) => m.l + ((t - xMin) / (xMax - xMin)) * iw;
  const y = (v) => m.t + ih - (v / yMax) * ih;

  const xTicks = ticksFor(xMin, xMax, 6);
  const yTicks = ticksFor(0, yMax, 5);

  const invX = (px) => xMin + ((px - m.l) / iw) * (xMax - xMin);

  function handlePointerMove(e) {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    if (svgX < m.l || svgX > m.l + iw || svgY < m.t || svgY > m.t + ih) {
      setHover(null);
      return;
    }
    const hx = invX(svgX);
    const baseR = results[0];
    const baseT = Math.max(0, Math.min(travel, hx + shift(baseR)));
    const baseVal = yMode === "force" ? forceAt(baseT, baseR) : rateAt(baseT, baseR);

    const rows = results.map((r, i) => {
      const t = Math.max(0, Math.min(travel, hx + shift(r)));
      const val = yMode === "force" ? forceAt(t, r) : rateAt(t, r);
      return {
        label: labels[i],
        val,
        t,
        delta: i === 0 ? null : pctDelta(val, baseVal),
        color: WIRE[i],
        gLoad: yMode === "force" && r.staticN > 0 ? val / r.staticN : null,
      };
    });

    const wrap = wrapRef.current?.getBoundingClientRect();
    setHover({
      svgX,
      hx,
      rows,
      tipX: wrap ? e.clientX - wrap.left : svgX,
      tipY: wrap ? e.clientY - wrap.top : svgY,
      flipX: wrap ? e.clientX - wrap.left > wrap.width * 0.62 : false,
    });
  }

  function curvePts(r) {
    const s = shift(r);
    if (yMode === "rate") {
      const v = r.kneeReached
        ? [[0, r.initial], [r.kneeTravel, r.initial], [r.kneeTravel, r.final], [travel, r.final]]
        : [[0, r.initial], [travel, r.initial]];
      return v.map(([t, val]) => `${x(t - s)},${y(Math.min(val, yMax))}`).join(" ");
    }
    const N = 80, pts = [];
    for (let k = 0; k <= N; k++) {
      const t = (travel * k) / N;
      pts.push(`${x(t - s)},${y(Math.min(forceAt(t, r), yMax))}`);
    }
    return pts.join(" ");
  }

  return (
    <div ref={wrapRef} style={{ width: "100%", overflowX: "auto", position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 520, display: "block", cursor: "crosshair" }}
        onMouseMove={handlePointerMove} onMouseLeave={() => setHover(null)}>
        {xTicks.map((t, i) => (
          <line key={"gx" + i} x1={x(t)} y1={m.t} x2={x(t)} y2={m.t + ih}
            stroke={Math.abs(t) < 1e-6 && xRef === "sag" ? "#3a424e" : "#242a33"} strokeWidth="1" />
        ))}
        {yTicks.map((f, i) => (
          <line key={"gy" + i} x1={m.l} y1={y(f)} x2={m.l + iw} y2={y(f)} stroke="#242a33" strokeWidth="1" />
        ))}
        <line x1={m.l} y1={m.t} x2={m.l} y2={m.t + ih} stroke="#3a424e" strokeWidth="1.5" />
        <line x1={m.l} y1={m.t + ih} x2={m.l + iw} y2={m.t + ih} stroke="#3a424e" strokeWidth="1.5" />

        {xTicks.map((t, i) => (
          <text key={"xt" + i} x={x(t)} y={m.t + ih + 22} fill="#8a93a0" fontSize="12" textAnchor="middle" fontFamily="ui-monospace, monospace">{t}</text>
        ))}
        {yTicks.map((f, i) => (
          <text key={"yt" + i} x={m.l - 10} y={y(f) + 4} fill="#8a93a0" fontSize="12" textAnchor="end" fontFamily="ui-monospace, monospace">{f}</text>
        ))}
        <text x={m.l + iw / 2} y={H - 4} fill="#a7b0bd" fontSize="12.5" textAnchor="middle">
          {xRef === "sag" ? "Travel from sag (mm)" : "Travel (mm)"}
        </text>
        <text x={14} y={m.t + ih / 2} fill="#a7b0bd" fontSize="12.5" textAnchor="middle" transform={`rotate(-90 14 ${m.t + ih / 2})`}>
          {yMode === "force" ? "Spring force (N)" : "Spring rate (lb/in)"}
        </text>

        {/* ride-height reference line */}
        {xRef === "sag" && (
          <g>
            <line x1={x(0)} y1={m.t} x2={x(0)} y2={m.t + ih} stroke="#c4ccd6" strokeWidth="1.2" strokeDasharray="4 3" opacity="0.8" />
            <text x={x(0) + 5} y={m.t + 12} fill="#c4ccd6" fontSize="11" fontFamily="ui-monospace, monospace">SAG</text>
          </g>
        )}

        {hover && (
          <line x1={hover.svgX} y1={m.t} x2={hover.svgX} y2={m.t + ih}
            stroke="#c4ccd6" strokeWidth="1" strokeDasharray="4 3" opacity="0.55" pointerEvents="none" />
        )}

        {results.map((r, i) => {
          const col = WIRE[i], s = shift(r);
          const kneeY = yMode === "force" ? r.Fknee : r.final;
          const sagCurveY = yMode === "force" ? Math.min(r.staticN, yMax) : rateAt(r.sag, r);
          return (
            <g key={"c" + i}>
              <polyline points={curvePts(r)} fill="none" stroke={col} strokeWidth="2.5" strokeLinejoin="round" />
              {r.kneeReached && (
                <g stroke={col} strokeWidth="2.2" strokeLinecap="round">
                  <line x1={x(r.kneeTravel - s) - 5} y1={y(Math.min(kneeY, yMax)) - 5}
                    x2={x(r.kneeTravel - s) + 5} y2={y(Math.min(kneeY, yMax)) + 5} />
                  <line x1={x(r.kneeTravel - s) - 5} y1={y(Math.min(kneeY, yMax)) + 5}
                    x2={x(r.kneeTravel - s) + 5} y2={y(Math.min(kneeY, yMax)) - 5} />
                </g>
              )}
              {xRef === "top" && (
                <g>
                  <line x1={x(r.sag)} y1={m.t + ih} x2={x(r.sag)} y2={y(sagCurveY)} stroke={col} strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                  <path d={diamond(x(r.sag), y(sagCurveY), 5)} fill="#14171c" stroke={col} strokeWidth="1.8" />
                </g>
              )}
              {gMarkers(r, travel).map((mk, mi) => {
                const curveY = yMode === "force" ? mk.force : rateAt(mk.t, r);
                if (curveY > yMax) return null;
                const cx = x(mk.t - s);
                const cy = y(curveY);
                const lp = gMarkerLabelPos(cx, cy, mk, mi, i, m.l + iw);
                return (
                  <g key={"g" + mk.label + mi}>
                    <circle cx={cx} cy={cy} r={mk.isMax ? 5 : 4} fill={col} stroke="#14171c" strokeWidth="1.5" />
                    <text x={lp.x} y={lp.y} textAnchor={lp.anchor} fill={col} fontSize="10" fontWeight="600"
                      fontFamily="ui-monospace, monospace">{mk.label}</text>
                  </g>
                );
              })}
            </g>
          );
        })}

        {/* legend */}
        <g>
          {results.map((_, i) => {
            const ly = m.t + 12 + i * 17;
            return (
              <g key={"lg" + i}>
                <line x1={m.l + 12} y1={ly} x2={m.l + 30} y2={ly} stroke={WIRE[i]} strokeWidth="2.5" />
                <circle cx={m.l + 21} cy={ly} r="3" fill={WIRE[i]} stroke="#14171c" strokeWidth="1" />
                <text x={m.l + 36} y={ly + 4} fill="#c4ccd6" fontSize="12.5" fontFamily="ui-monospace, monospace">{labels[i]}</text>
              </g>
            );
          })}
        </g>
      </svg>
      {hover && (
        <div style={{
          ...S.tooltip,
          left: hover.tipX,
          top: hover.tipY,
          transform: hover.flipX ? "translate(calc(-100% - 10px), calc(-100% - 10px))" : "translate(10px, -10px)",
        }}>
          <div style={S.tooltipHead}>
            {xRef === "sag"
              ? `${hover.hx.toFixed(1)} mm from sag`
              : `${hover.hx.toFixed(1)} mm travel`}
          </div>
          {hover.rows.map((row, i) => (
            <div key={i} style={S.tooltipRow}>
              <span style={{ ...S.dot, background: row.color, marginRight: 6 }} />
              <span style={S.tooltipLabel}>{row.label}</span>
              <span style={S.tooltipVal}>
                {yMode === "force"
                  ? `${row.val.toFixed(0)} N`
                  : `${row.val.toFixed(1)} lb/in`}
                {row.gLoad != null && (
                  <span style={S.tooltipSub}> · {row.gLoad.toFixed(2)}g</span>
                )}
              </span>
              <span style={S.tooltipDelta}>
                {i === 0 ? "base" : row.delta == null ? "—" : `${row.delta >= 0 ? "+" : ""}${row.delta.toFixed(1)}%`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function diamond(cx, cy, r) {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`;
}

function Field({ label, hint, children }) {
  return (
    <label style={S.field}>
      <span style={S.fieldLabel}>{label}</span>
      {children}
      {hint && <span style={S.hint}>{hint}</span>}
    </label>
  );
}

function pctDelta(v, base) {
  if (v == null || base == null || base === 0) return null;
  return ((v - base) / base) * 100;
}

function Row({ label, unit, raw, fmt, sub, highlight }) {
  const base = raw[0];
  return (
    <tr style={highlight ? { background: "rgba(242,183,5,0.06)" } : undefined}>
      <td style={S.tdLabel}>{label} <span style={S.unit}>{unit}</span></td>
      {raw.map((v, i) => {
        const d = i === 0 ? null : pctDelta(v, base);
        return (
          <td key={i} style={S.tdVal}>
            <span style={S.bigVal}>{v == null ? "—" : fmt(v)}</span>
            {sub && <span style={S.subVal}>{sub[i]}</span>}
            <span style={S.delta}>
              {i === 0 ? "baseline" : d == null ? "—" : `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`}
            </span>
          </td>
        );
      })}
    </tr>
  );
}

const S = {
  root: { fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Inter, sans-serif", background: "#14171c", color: "#e6e9ee", padding: "28px 22px 40px", maxWidth: 980, margin: "0 auto", minHeight: "100%" },
  header: { marginBottom: 22 },
  eyebrow: { fontFamily: "ui-monospace, monospace", fontSize: 11, letterSpacing: "0.18em", color: "#f2b705", marginBottom: 8 },
  h1: { fontSize: 30, fontWeight: 650, margin: "0 0 8px", letterSpacing: "-0.01em" },
  sub: { color: "#8a93a0", fontSize: 14.5, lineHeight: 1.55, maxWidth: 620, margin: 0 },
  panel: { background: "#1a1e24", border: "1px solid #262c35", borderRadius: 12, padding: "18px 18px 20px", marginTop: 16 },
  panelHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 14 },
  panelLabel: { fontFamily: "ui-monospace, monospace", fontSize: 11.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "#a7b0bd", marginBottom: 14 },
  baseNote: { textTransform: "none", letterSpacing: 0, color: "#6b7480", fontSize: 11 },
  globalGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 12.5, color: "#c4ccd6", fontWeight: 500 },
  hint: { fontSize: 11, color: "#6b7480", lineHeight: 1.3 },
  input: { background: "#0f1216", border: "1px solid #2c333d", borderRadius: 8, color: "#e6e9ee", padding: "9px 10px", fontSize: 14, fontFamily: "ui-monospace, monospace", width: "100%", boxSizing: "border-box", outline: "none" },
  setupRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 },
  setupCard: { background: "#0f1216", border: "1px solid #262c35", borderTop: "3px solid", borderRadius: 10, padding: 14, display: "flex", flexDirection: "column", gap: 12 },
  setupHead: { display: "flex", alignItems: "center", gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 3, display: "inline-block", flexShrink: 0 },
  nameInput: { background: "transparent", border: "none", color: "#e6e9ee", fontSize: 15, fontWeight: 600, flex: 1, outline: "none", padding: "2px 0" },
  setupTitle: { fontFamily: "ui-monospace, monospace", fontSize: 16, fontWeight: 700, color: "#e6e9ee", flex: 1, letterSpacing: "0.02em" },
  baseBadge: { fontSize: 9.5, fontFamily: "ui-monospace, monospace", letterSpacing: "0.1em", color: "#14171c", background: "#f2b705", borderRadius: 4, padding: "1px 5px", fontWeight: 700 },
  baseBadgeSm: { fontSize: 9, fontFamily: "ui-monospace, monospace", color: "#f2b705", border: "1px solid #3a3520", borderRadius: 3, padding: "0px 4px", marginLeft: 6, verticalAlign: "middle" },
  pairRow: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 },
  plotKey: { marginTop: 10, fontSize: 12, color: "#c4ccd6", fontFamily: "ui-monospace, monospace", display: "flex", flexWrap: "wrap", gap: 4 },
  tooltip: {
    position: "absolute", pointerEvents: "none", zIndex: 10,
    background: "#0f1216", border: "1px solid #3a424e", borderRadius: 8,
    padding: "8px 10px", minWidth: 188, boxShadow: "0 8px 24px rgba(0,0,0,0.45)",
    fontFamily: "ui-monospace, monospace", fontSize: 11,
  },
  tooltipHead: { color: "#a7b0bd", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6, paddingBottom: 5, borderBottom: "1px solid #262c35" },
  tooltipRow: { display: "grid", gridTemplateColumns: "auto 1fr auto auto", alignItems: "center", gap: "2px 8px", padding: "3px 0" },
  tooltipLabel: { color: "#c4ccd6", fontWeight: 600 },
  tooltipVal: { color: "#e6e9ee", textAlign: "right", fontVariantNumeric: "tabular-nums" },
  tooltipSub: { color: "#6b7480", fontSize: 10 },
  tooltipDelta: { color: "#8a93a0", fontSize: 10, textAlign: "right", minWidth: 44, fontVariantNumeric: "tabular-nums" },
  table: { width: "100%", borderCollapse: "collapse", minWidth: 460 },
  th: { fontSize: 12.5, color: "#c4ccd6", fontWeight: 600, textAlign: "right", padding: "8px 12px", borderBottom: "1px solid #2c333d", whiteSpace: "nowrap" },
  tdLabel: { fontSize: 13, color: "#a7b0bd", padding: "11px 12px", borderBottom: "1px solid #20262e", whiteSpace: "nowrap" },
  unit: { fontSize: 11, color: "#6b7480", fontFamily: "ui-monospace, monospace" },
  tdVal: { textAlign: "right", padding: "9px 12px", borderBottom: "1px solid #20262e" },
  bigVal: { display: "block", fontFamily: "ui-monospace, monospace", fontSize: 17, fontWeight: 600, color: "#e6e9ee", fontVariantNumeric: "tabular-nums" },
  subVal: { display: "block", fontSize: 11, color: "#6b7480", fontFamily: "ui-monospace, monospace" },
  delta: { display: "block", fontSize: 11, color: "#8a93a0", fontFamily: "ui-monospace, monospace", marginTop: 1 },
  warn: { marginTop: 14, fontSize: 12.5, color: "#f2b705", background: "rgba(242,183,5,0.08)", border: "1px solid rgba(242,183,5,0.25)", borderRadius: 8, padding: "10px 12px", lineHeight: 1.5 },
  footer: { marginTop: 18, fontSize: 11.5, color: "#6b7480", lineHeight: 1.55 },
};

const CSS = `
  .in:focus { border-color: #f2b705 !important; }
  select.in { appearance: none; cursor: pointer; }
  .seg { display: flex; border: 1px solid #2c333d; border-radius: 8px; overflow: hidden; }
  .segbtn { background: #0f1216; color: #8a93a0; border: none; padding: 6px 12px; font-size: 13px; cursor: pointer; font-family: ui-monospace, monospace; }
  .segbtn.on { background: #f2b705; color: #14171c; font-weight: 700; }
  .ghost { background: transparent; color: #f2b705; border: 1px solid #3a3520; border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; font-weight: 600; }
  .ghost:disabled { opacity: 0.4; cursor: not-allowed; }
  .ghost:hover:not(:disabled) { background: rgba(242,183,5,0.08); }
  .x { background: transparent; color: #6b7480; border: none; font-size: 20px; line-height: 1; cursor: pointer; padding: 0 4px; }
  .x:hover { color: #e0507a; }
  input[disabled] { opacity: 0.55; }
`;