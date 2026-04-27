const TEAM_COLORS = {
    "Red Bull Racing": "#3671C6",
    "Mercedes": "#27F4D2",
    "Ferrari": "#E8002D",
    "McLaren": "#FF8000",
    "Aston Martin": "#229971",
    "Alpine": "#FF87BC",
    "Williams": "#64C4FF",
    "AlphaTauri": "#6692FF",
    "Haas": "#B6BABD",
    "Kick Sauber": "#52E252",
    "Alfa Romeo": "#9B0000",
    "RB": "#4B7BFF",
    "Audi": "#BB0A30",
    "Cadillac": "#003A8F",
};

const ROW_HEIGHT = 46;
const TRACK_WIDTH = 1000;
const TRACK_HEIGHT = 700;
const TRACK_PAD = 70;

const COMPOUND_META = {
    SOFT: { short: "S", color: "#ff3b30", label: "SOFT" },
    MEDIUM: { short: "M", color: "#ffd43b", label: "MEDIUM" },
    HARD: { short: "H", color: "#d8dde5", label: "HARD" },
    INTER: { short: "I", color: "#35d07f", label: "INTER" },
    WET: { short: "W", color: "#4da3ff", label: "WET" },
    UNKNOWN: { short: "UNK", color: "#8a95a8", label: "UNKNOWN" },
};

const appState = {
    mode: "race",
    sessionInfo: {},
    drivers: [],
    driverMap: {},
    driverByAcronym: {},
    indexes: {},
    trackModel: null,
    raceControlEvents: [],
    timelineMarkers: [],
    showPitMarkers: true,
    replay: {
        startMs: 0,
        endMs: 0,
        durationMs: 0,
        currentMs: 0,
        speed: 1,
        playing: false,
        lastTick: 0,
        rafId: null,
    },
    ui: {
        rowsByDriver: new Map(),
        dotsByDriver: new Map(),
        prevPositions: new Map(),
        selectedDriver: null,
        sectorOverlays: [],
    },
};

async function apiFetch(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            url.searchParams.set(key, value);
        }
    });

    const res = await fetch(url);
    if (!res.ok) {
        let payload = null;
        try {
            payload = await res.json();
        } catch (_) {
            payload = null;
        }

        const retryAfter = payload?.retry_after;
        const apiError = payload?.error;
        const baseMessage = apiError || `Request failed with ${res.status}`;
        const hint = res.status === 429
            ? ` Rate limit reached${retryAfter ? `, retry in ${retryAfter}s.` : "."}`
            : "";
        throw new Error(`${baseMessage}${hint}`);
    }

    return res.json();
}

function showStatus(message, type = "loading") {
    const el = document.getElementById("status");
    el.className = `status ${type}`;
    el.innerHTML = type === "loading"
        ? `<div class="spinner"></div><span>${message}</span>`
        : `<span>${message}</span>`;
    el.classList.remove("hidden");
}

function hideStatus() {
    document.getElementById("status").classList.add("hidden");
}

function teamColor(teamName) {
    if (!teamName) return "#78859d";
    const key = Object.keys(TEAM_COLORS).find((item) => teamName.toLowerCase().includes(item.toLowerCase()));
    return key ? TEAM_COLORS[key] : "#78859d";
}

function parseTimeMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
}

function latestIndexAtOrBefore(series, ms) {
    let left = 0;
    let right = series.length - 1;
    let best = -1;

    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (series[mid].ms <= ms) {
            best = mid;
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }

    return best;
}

function latestValue(series, ms) {
    if (!series.length) return null;
    const idx = latestIndexAtOrBefore(series, ms);
    return idx >= 0 ? series[idx] : null;
}

function formatElapsed(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(seconds / 3600).toString().padStart(2, "0");
    const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, "0");
    const s = Math.floor(seconds % 60).toString().padStart(2, "0");
    return `${h}:${m}:${s}`;
}

function formatClockTime(ms) {
    const d = new Date(ms);
    return d.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "UTC",
    });
}

function formatLapTime(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "--";
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(3).padStart(6, "0");
    return `${mins}:${secs}`;
}

function normalizeCompound(compound) {
    if (!compound) return "UNKNOWN";
    const txt = String(compound).trim().toUpperCase();
    if (txt.startsWith("SOFT") || txt === "S") return "SOFT";
    if (txt.startsWith("MED") || txt === "M" || txt.includes("YELLOW")) return "MEDIUM";
    if (txt.startsWith("HAR") || txt === "H" || txt.includes("WHITE")) return "HARD";
    if (txt.startsWith("INT") || txt === "I" || txt.includes("INTER")) return "INTER";
    if (txt.startsWith("WET") || txt === "W" || txt.includes("BLUE")) return "WET";
    return "UNKNOWN";
}

function parseNumericGap(raw) {
    if (raw === null || raw === undefined || raw === "") return null;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    const parsed = Number(String(raw).replace("+", "").trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function formatGap(gap, position) {
    if (position === 1) return "LEADER";
    if (Number.isFinite(gap)) return `+${gap.toFixed(3)}`;
    return "--";
}

function formatGapValue(gap, gapRaw, position) {
    if (position === 1) return "LEADER";
    if (Number.isFinite(gap)) return `+${gap.toFixed(3)}`;
    if (gapRaw !== null && gapRaw !== undefined && String(gapRaw).trim()) {
        return String(gapRaw).trim().toUpperCase();
    }
    return "--";
}

function formatInterval(raw) {
    if (raw === null || raw === undefined || raw === "") return "--";
    if (typeof raw === "number" && Number.isFinite(raw)) return `+${raw.toFixed(3)}`;
    const txt = String(raw).trim();
    return txt ? txt.toUpperCase() : "--";
}

function sessionMode(sessionInfo) {
    const type = String(sessionInfo?.session_type || sessionInfo?.session_name || "").toLowerCase();
    if (type.includes("race") || type.includes("sprint")) return "race";
    return "timed";
}

function isTimedLap(lap) {
    if (!lap) return false;
    if (lap.is_pit_out_lap) return false;
    if (!Number.isFinite(lap.lap_duration)) return false;
    if (lap.lap_duration <= 45 || lap.lap_duration >= 180) return false;
    return true;
}

function toPath(points) {
    if (!points.length) return "";
    return points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
}

function toClosedPath(points) {
    if (!points.length) return "";
    return `${toPath(points)} Z`;
}

function splitIntoSectors(points) {
    if (points.length < 6) return [points, points, points];
    const a = Math.floor(points.length / 3);
    const b = Math.floor((points.length * 2) / 3);
    return [
        points.slice(0, a + 1),
        points.slice(Math.max(0, a - 1), b + 1),
        points.slice(Math.max(0, b - 1)),
    ];
}

function normalizePoint(rawX, rawY, bounds) {
    const spanX = Math.max(1, bounds.maxX - bounds.minX);
    const spanY = Math.max(1, bounds.maxY - bounds.minY);
    const xNorm = (rawX - bounds.minX) / spanX;
    const yNorm = (rawY - bounds.minY) / spanY;
    const x = TRACK_PAD + xNorm * (TRACK_WIDTH - TRACK_PAD * 2);
    const y = TRACK_PAD + (1 - yNorm) * (TRACK_HEIGHT - TRACK_PAD * 2);
    return { x, y };
}

function createCoordinateNormalizer(bounds) {
    const rawWidth = Math.max(1, bounds.maxX - bounds.minX);
    const rawHeight = Math.max(1, bounds.maxY - bounds.minY);
    const drawableWidth = TRACK_WIDTH - TRACK_PAD * 2;
    const drawableHeight = TRACK_HEIGHT - TRACK_PAD * 2;
    const scale = Math.min(drawableWidth / rawWidth, drawableHeight / rawHeight);
    const usedWidth = rawWidth * scale;
    const usedHeight = rawHeight * scale;
    const offsetX = TRACK_PAD + (drawableWidth - usedWidth) / 2;
    const offsetY = TRACK_PAD + (drawableHeight - usedHeight) / 2;

    return (rawX, rawY) => ({
        x: offsetX + (rawX - bounds.minX) * scale,
        y: offsetY + (bounds.maxY - rawY) * scale,
    });
}

function dedupeSequentialPoints(points, epsilon = 0.0001) {
    if (!points.length) return [];
    const out = [points[0]];
    for (let i = 1; i < points.length; i += 1) {
        const prev = out[out.length - 1];
        const cur = points[i];
        if (Math.abs(cur.x - prev.x) > epsilon || Math.abs(cur.y - prev.y) > epsilon) {
            out.push(cur);
        }
    }
    return out;
}

function distanceSquared(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return dx * dx + dy * dy;
}

function simplifyByDistance(points, minDistance = 6) {
    if (points.length <= 2) return points.slice();
    const out = [points[0]];
    const minDistSq = minDistance * minDistance;
    for (let i = 1; i < points.length; i += 1) {
        if (distanceSquared(points[i], out[out.length - 1]) >= minDistSq) {
            out.push(points[i]);
        }
    }
    if (out.length >= 2 && distanceSquared(out[0], out[out.length - 1]) < minDistSq / 2) {
        out.pop();
    }
    return out;
}

function catmullRomClosed(points, samplesPerSegment = 4) {
    if (points.length < 4) return points.slice();
    const out = [];
    const n = points.length;

    for (let i = 0; i < n; i += 1) {
        const p0 = points[(i - 1 + n) % n];
        const p1 = points[i % n];
        const p2 = points[(i + 1) % n];
        const p3 = points[(i + 2) % n];

        for (let j = 0; j < samplesPerSegment; j += 1) {
            const t = j / samplesPerSegment;
            const t2 = t * t;
            const t3 = t2 * t;

            const x = 0.5 * (
                (2 * p1.x)
                + (-p0.x + p2.x) * t
                + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2
                + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3
            );
            const y = 0.5 * (
                (2 * p1.y)
                + (-p0.y + p2.y) * t
                + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2
                + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3
            );

            out.push({ x, y });
        }
    }

    return out;
}

function deriveStintAge(stint, lapNumber) {
    if (!Number.isFinite(lapNumber)) return stint.tyreAgeAtStart;
    if (!Number.isFinite(stint.tyreAgeAtStart)) return null;
    if (!Number.isFinite(stint.lapStart)) return stint.tyreAgeAtStart;
    const delta = Math.max(0, lapNumber - stint.lapStart);
    return stint.tyreAgeAtStart + delta;
}

function pickReferenceLapSeries(byDriver) {
    let best = [];

    Object.values(byDriver).forEach((series) => {
        const timedCandidates = series.lapEndSeries
            .filter((lap) => lap.timed && Number.isFinite(lap.ms) && Number.isFinite(lap.endMs));

        for (let i = Math.floor(timedCandidates.length / 3); i < timedCandidates.length; i += 1) {
            const lap = timedCandidates[i];
            const points = series.locationSeries.filter((pt) => pt.ms >= lap.ms && pt.ms <= lap.endMs);
            if (points.length > best.length) {
                best = points;
            }
            if (best.length >= 80) break;
        }
    });

    if (best.length) return best;

    const densest = Object.values(byDriver)
        .slice()
        .sort((a, b) => b.locationSeries.length - a.locationSeries.length)[0];

    return densest?.locationSeries || [];
}

function resolveTyreState(series, currentMs, lapNumber, currentLapRecord) {
    const lapCompound = normalizeCompound(currentLapRecord?.compound);
    if (lapCompound !== "UNKNOWN") {
        const meta = COMPOUND_META[lapCompound];
        return {
            compound: lapCompound,
            meta,
            age: Number.isFinite(currentLapRecord?.tyreAge) ? currentLapRecord.tyreAge : null,
        };
    }

    const activeStint = series.stintSeries.find((stint) => {
        const byLap = Number.isFinite(lapNumber)
            && Number.isFinite(stint.lapStart)
            && Number.isFinite(stint.lapEnd)
            && lapNumber >= stint.lapStart
            && lapNumber <= stint.lapEnd;
        if (byLap) return true;

        const hasDateRange = Number.isFinite(stint.startMs) && Number.isFinite(stint.endMs);
        if (!hasDateRange) return false;
        return currentMs >= stint.startMs && currentMs <= stint.endMs;
    }) || null;

    if (!activeStint) {
        return {
            compound: "UNKNOWN",
            meta: COMPOUND_META.UNKNOWN,
            age: null,
        };
    }

    const compound = normalizeCompound(activeStint.compound);
    return {
        compound,
        meta: COMPOUND_META[compound] || COMPOUND_META.UNKNOWN,
        age: deriveStintAge(activeStint, lapNumber),
    };
}

function tyreCellMarkup(tyreState) {
    const meta = tyreState?.meta || COMPOUND_META.UNKNOWN;
    const age = Number.isFinite(tyreState?.age) ? `${Math.round(tyreState.age)}L` : "";
    return `
        <span class="tyre-pill">
            <span class="tyre-dot" style="background:${meta.color}" title="${meta.label}"></span>
            <span class="tyre-short">${meta.short}</span>
            <span class="tyre-age">${age}</span>
        </span>
    `;
}

function extractSector(text) {
    const source = String(text || "").toUpperCase();
    const match = source.match(/(?:SECTOR|S)\s*([123])/i);
    if (!match) return null;
    return Number(match[1]);
}

function buildIndexes(drivers, positions, laps, intervals, locations, stints) {
    const byDriver = {};

    drivers.forEach((driver) => {
        byDriver[driver.driver_number] = {
            positionSeries: [],
            gapSeries: [],
            intervalSeries: [],
            lapStartSeries: [],
            lapEndSeries: [],
            locationSeries: [],
            pitWindows: [],
            pitMarkers: [],
            stintSeries: [],
        };
    });

    positions.forEach((item) => {
        if (item.driver_number == null || item.position == null) return;
        const bucket = byDriver[item.driver_number];
        if (!bucket) return;
        const ms = parseTimeMs(item.date);
        if (ms === null) return;
        bucket.positionSeries.push({ ms, position: Number(item.position) });
    });

    intervals.forEach((item) => {
        if (item.driver_number == null) return;
        const bucket = byDriver[item.driver_number];
        if (!bucket) return;
        const ms = parseTimeMs(item.date);
        if (ms === null) return;

        const gapRaw = item.gap_to_leader ?? item.interval_to_leader ?? item.gap ?? null;
        const aheadRaw = item.interval_to_position_ahead ?? item.interval_to_car_ahead ?? item.interval ?? null;

        bucket.gapSeries.push({
            ms,
            gap: parseNumericGap(gapRaw),
            raw: gapRaw,
        });
        bucket.intervalSeries.push({
            ms,
            interval: aheadRaw,
        });
    });

    laps.forEach((item) => {
        if (item.driver_number == null || item.lap_number == null) return;
        const bucket = byDriver[item.driver_number];
        if (!bucket) return;
        const startMs = parseTimeMs(item.date_start);
        if (startMs === null) return;

        const duration = Number(item.lap_duration);
        const endMs = Number.isFinite(duration) ? startMs + Math.round(duration * 1000) : startMs;
        const lapNumber = Number(item.lap_number);

        const record = {
            ms: startMs,
            endMs,
            lapNumber,
            lapDuration: Number.isFinite(duration) ? duration : null,
            s1: Number.isFinite(item.duration_sector_1) ? item.duration_sector_1 : null,
            s2: Number.isFinite(item.duration_sector_2) ? item.duration_sector_2 : null,
            s3: Number.isFinite(item.duration_sector_3) ? item.duration_sector_3 : null,
            isPitOut: Boolean(item.is_pit_out_lap),
            timed: isTimedLap(item),
            compound: item.compound || item.tyre_compound || item.tire_compound || null,
            tyreAge: Number.isFinite(item.tyre_age_at_start) ? item.tyre_age_at_start : null,
        };

        bucket.lapStartSeries.push({ ms: startMs, lapNumber });
        bucket.lapEndSeries.push(record);

        if (record.isPitOut) {
            bucket.pitWindows.push({
                startMs,
                endMs: startMs + 20000,
                lapNumber,
            });
            bucket.pitMarkers.push({
                ms: startMs,
                lapNumber,
                label: `PIT OUT L${lapNumber}`,
            });
        }
    });

    locations.forEach((item) => {
        if (item.driver_number == null) return;
        const bucket = byDriver[item.driver_number];
        if (!bucket) return;
        const ms = parseTimeMs(item.date);
        if (ms === null) return;

        const x = Number(item.x ?? item.X);
        const y = Number(item.y ?? item.Y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;

        bucket.locationSeries.push({
            ms,
            x,
            y,
            z: Number.isFinite(item.z) ? Number(item.z) : null,
        });
    });

    stints.forEach((item) => {
        if (item.driver_number == null) return;
        const bucket = byDriver[item.driver_number];
        if (!bucket) return;

        const lapStart = Number(item.lap_start ?? item.lap_number_start ?? item.stint_start_lap);
        const lapEnd = Number(item.lap_end ?? item.lap_number_end ?? item.stint_end_lap);
        const startMs = parseTimeMs(item.date_start ?? item.start_date ?? item.date);
        const endMs = parseTimeMs(item.date_end ?? item.end_date);

        const tyreAgeAtStart = Number(item.tyre_age_at_start ?? item.tire_age_at_start);

        bucket.stintSeries.push({
            lapStart: Number.isFinite(lapStart) ? lapStart : null,
            lapEnd: Number.isFinite(lapEnd) ? lapEnd : null,
            startMs: Number.isFinite(startMs) ? startMs : null,
            endMs: Number.isFinite(endMs) ? endMs : null,
            compound: item.compound ?? item.tyre_compound ?? item.tire_compound ?? null,
            tyreAgeAtStart: Number.isFinite(tyreAgeAtStart) ? tyreAgeAtStart : null,
        });
    });

    const allMs = [];
    let maxLapNumber = 0;

    Object.values(byDriver).forEach((series) => {
        series.positionSeries.sort((a, b) => a.ms - b.ms);
        series.gapSeries.sort((a, b) => a.ms - b.ms);
        series.intervalSeries.sort((a, b) => a.ms - b.ms);
        series.lapStartSeries.sort((a, b) => a.ms - b.ms);
        series.lapEndSeries.sort((a, b) => a.ms - b.ms);
        series.locationSeries.sort((a, b) => a.ms - b.ms);
        series.pitWindows.sort((a, b) => a.startMs - b.startMs);
        series.pitMarkers.sort((a, b) => a.ms - b.ms);
        series.stintSeries.sort((a, b) => {
            const aKey = Number.isFinite(a.lapStart) ? a.lapStart : (a.startMs || 0);
            const bKey = Number.isFinite(b.lapStart) ? b.lapStart : (b.startMs || 0);
            return aKey - bKey;
        });

        series.positionSeries.forEach((it) => allMs.push(it.ms));
        series.gapSeries.forEach((it) => allMs.push(it.ms));
        series.intervalSeries.forEach((it) => allMs.push(it.ms));
        series.lapStartSeries.forEach((it) => {
            allMs.push(it.ms);
            maxLapNumber = Math.max(maxLapNumber, it.lapNumber || 0);
        });
        series.lapEndSeries.forEach((it) => allMs.push(it.endMs));
        series.locationSeries.forEach((it) => allMs.push(it.ms));
    });

    const startMs = allMs.length ? Math.min(...allMs) : Date.now();
    const endMs = allMs.length ? Math.max(...allMs) : startMs;

    return {
        byDriver,
        startMs,
        endMs,
        maxLapNumber,
    };
}

function buildTrackModel(indexes) {
    const rawPoints = [];
    const referenceSeries = pickReferenceLapSeries(indexes.byDriver);

    Object.values(indexes.byDriver).forEach((series) => {
        series.locationSeries.forEach((pt) => rawPoints.push({ x: pt.x, y: pt.y, ms: pt.ms }));
    });

    if (!rawPoints.length) {
        const fallback = [
            { x: 140, y: 350 },
            { x: 250, y: 220 },
            { x: 470, y: 180 },
            { x: 680, y: 220 },
            { x: 860, y: 360 },
            { x: 760, y: 520 },
            { x: 520, y: 590 },
            { x: 290, y: 560 },
            { x: 150, y: 430 },
            { x: 140, y: 350 },
        ];
        return {
            pathPoints: fallback,
            path: toPath(fallback),
            sectors: splitIntoSectors(fallback).map(toPath),
        };
    }

    const bounds = {
        minX: Math.min(...rawPoints.map((p) => p.x)),
        maxX: Math.max(...rawPoints.map((p) => p.x)),
        minY: Math.min(...rawPoints.map((p) => p.y)),
        maxY: Math.max(...rawPoints.map((p) => p.y)),
    };

    const normalize = createCoordinateNormalizer(bounds);

    const referenceRaw = dedupeSequentialPoints(referenceSeries.map((pt) => ({ x: pt.x, y: pt.y })));
    const referenceNormalized = referenceRaw.map((pt) => normalize(pt.x, pt.y));
    const simplified = simplifyByDistance(referenceNormalized, 4);
    const smoothed = catmullRomClosed(simplified, 5);
    const pathPoints = smoothed.length ? smoothed : simplified;

    Object.values(indexes.byDriver).forEach((series) => {
        series.locationSeriesNormalized = series.locationSeries.map((pt) => {
            const normalized = normalize(pt.x, pt.y);
            return {
                ms: pt.ms,
                x: normalized.x,
                y: normalized.y,
            };
        });
    });

    return {
        pathPoints,
        path: toClosedPath(pathPoints),
        sectors: splitIntoSectors(pathPoints).map(toPath),
    };
}

function classifyRaceControl(entry) {
    const msg = String(entry?.message || "").toUpperCase();
    const flag = String(entry?.flag || "").toUpperCase();
    const category = String(entry?.category || "").toUpperCase();
    const content = `${msg} ${flag} ${category}`;

    let type = null;
    if (content.includes("RED")) type = "red";
    else if (content.includes("VSC") || content.includes("VIRTUAL SAFETY")) type = "vsc";
    else if (content.includes("SAFETY CAR") || content.includes("SC")) type = "sc";
    else if (content.includes("YELLOW")) type = "yellow";
    else if (content.includes("GREEN")) type = "green";
    else if (content.includes("CHEQUERED") || content.includes("CHECKERED")) type = "end";

    const clear = /CLEAR|ENDED|END|WITHDRAWN|GREEN FLAG|RESUME/i.test(content);
    const sector = extractSector(content);

    return {
        type,
        clear,
        sector,
        text: entry?.message || entry?.category || entry?.flag || "Race control",
    };
}

function buildRaceControlEvents(raceControl, startMs, endMs) {
    const events = [];

    raceControl.forEach((item) => {
        const ms = parseTimeMs(item.date);
        if (ms === null) return;
        const parsed = classifyRaceControl(item);
        if (!parsed.type) return;

        events.push({
            ms,
            ...parsed,
        });
    });

    events.sort((a, b) => a.ms - b.ms);

    const markers = [
        { ms: startMs, type: "start", label: "Session start" },
        ...events.filter((e) => ["yellow", "sc", "vsc", "red", "end"].includes(e.type)).map((e) => ({
            ms: e.ms,
            type: e.type,
            sector: e.sector,
            label: e.text,
        })),
        { ms: endMs, type: "end", label: "Session end" },
    ];

    return {
        events,
        markers,
    };
}

function getActiveFlag(currentMs) {
    const relevant = appState.raceControlEvents.filter((event) => event.ms <= currentMs);
    if (!relevant.length) return { type: "green", text: "GREEN" };

    let active = { type: "green", text: "GREEN", sector: null };
    relevant.forEach((event) => {
        if (["yellow", "sc", "vsc", "red"].includes(event.type)) {
            if (event.clear) {
                active = { type: "green", text: "GREEN", sector: null };
            } else {
                const sectorText = event.sector ? ` S${event.sector}` : "";
                active = {
                    type: event.type,
                    text: `${event.type.toUpperCase()}${sectorText}`,
                    sector: event.sector || null,
                };
            }
        }
        if (event.type === "green") {
            active = { type: "green", text: "GREEN", sector: null };
        }
    });

    return active;
}

function getInterpolatedPoint(series, currentMs) {
    if (!series.length) return null;

    const idx = latestIndexAtOrBefore(series, currentMs);
    if (idx < 0) return series[0];
    if (idx >= series.length - 1) return series[series.length - 1];

    const a = series[idx];
    const b = series[idx + 1];
    const dt = b.ms - a.ms;
    if (dt <= 0 || dt > 5000) return a;

    const t = Math.max(0, Math.min(1, (currentMs - a.ms) / dt));
    return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
    };
}

function isDriverInPit(driverNumber, currentMs) {
    const series = appState.indexes.byDriver[driverNumber];
    if (!series) return false;
    return series.pitWindows.some((window) => currentMs >= window.startMs && currentMs <= window.endMs);
}

function makeSvgEl(name, attrs = {}) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, String(value)));
    return el;
}

function setSelectedDriver(driverNumber) {
    const selected = appState.ui.selectedDriver === driverNumber ? null : driverNumber;
    appState.ui.selectedDriver = selected;

    appState.ui.rowsByDriver.forEach((row, dn) => {
        row.classList.toggle("active", selected === dn);
    });

    appState.ui.dotsByDriver.forEach((dot, dn) => {
        dot.classList.toggle("active", selected === dn);
    });
}

function initMap() {
    const svg = document.getElementById("track-map");
    svg.innerHTML = "";

    svg.appendChild(makeSvgEl("path", { d: appState.trackModel.path, class: "track-outline" }));
    svg.appendChild(makeSvgEl("path", { d: appState.trackModel.path, class: "track-glow" }));
    svg.appendChild(makeSvgEl("path", { d: appState.trackModel.path, class: "track-line" }));

    appState.ui.sectorOverlays = appState.trackModel.sectors.map((path, idx) => {
        const overlay = makeSvgEl("path", {
            d: path,
            class: "sector-overlay",
            "data-sector": idx + 1,
        });
        svg.appendChild(overlay);
        return overlay;
    });

    appState.ui.dotsByDriver.clear();
    appState.drivers.forEach((driver) => {
        const g = makeSvgEl("g", {
            class: "driver-dot",
            "data-driver": driver.driver_number,
            tabindex: 0,
        });

        const color = teamColor(driver.team_name);
        g.appendChild(makeSvgEl("circle", {
            cx: 0,
            cy: 0,
            r: 8,
            fill: color,
        }));
        const label = makeSvgEl("text", {
            x: 12,
            y: 3,
        });
        label.textContent = driver.name_acronym || `#${driver.driver_number}`;
        g.appendChild(label);

        g.addEventListener("click", () => setSelectedDriver(driver.driver_number));
        g.addEventListener("keypress", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setSelectedDriver(driver.driver_number);
            }
        });

        svg.appendChild(g);
        appState.ui.dotsByDriver.set(driver.driver_number, g);
    });
}

function buildTimelineScale() {
    const scale = document.getElementById("timeline-scale");
    const tickCount = 6;

    if (appState.mode === "race" && appState.indexes.maxLapNumber > 0) {
        const labels = [];
        for (let i = 0; i <= tickCount; i += 1) {
            const lap = Math.max(1, Math.round((appState.indexes.maxLapNumber * i) / tickCount));
            labels.push(`<span>L${lap}</span>`);
        }
        scale.innerHTML = labels.join("");
        return;
    }

    const labels = [];
    for (let i = 0; i <= tickCount; i += 1) {
        labels.push(`<span>${formatElapsed(((appState.replay.durationMs / 1000) * i) / tickCount)}</span>`);
    }
    scale.innerHTML = labels.join("");
}

function buildTimelineMarkers() {
    const container = document.getElementById("timeline-markers");
    container.innerHTML = "";

    const markers = [...appState.timelineMarkers];
    if (appState.showPitMarkers) {
        Object.entries(appState.indexes.byDriver).forEach(([driverNumber, series]) => {
            const driver = appState.driverMap[driverNumber];
            series.pitMarkers.forEach((marker) => {
                markers.push({
                    ms: marker.ms,
                    type: "pit",
                    label: `${driver?.name_acronym || driverNumber} ${marker.label}`,
                });
            });
        });
    }

    const span = Math.max(1, appState.replay.endMs - appState.replay.startMs);

    markers.forEach((marker) => {
        const pct = ((marker.ms - appState.replay.startMs) / span) * 100;
        const el = document.createElement("div");
        el.className = `timeline-marker ${marker.type}`;
        el.style.left = `${Math.max(0, Math.min(100, pct))}%`;

        const sec = Math.max(0, (marker.ms - appState.replay.startMs) / 1000);
        const descriptor = marker.sector ? ` - S${marker.sector}` : "";
        el.title = `${marker.label}${descriptor}\n${formatElapsed(sec)}`;

        container.appendChild(el);
    });
}

function setSpeed(speed) {
    appState.replay.speed = speed;
    document.querySelectorAll(".speed-btn").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.speed) === speed);
    });
}

function stopPlayback() {
    appState.replay.playing = false;
    if (appState.replay.rafId) {
        cancelAnimationFrame(appState.replay.rafId);
        appState.replay.rafId = null;
    }
    document.getElementById("play-btn").textContent = "Play";
}

function playbackStep(now) {
    if (!appState.replay.playing) return;
    const dtMs = now - appState.replay.lastTick;
    appState.replay.lastTick = now;

    const nextMs = appState.replay.currentMs + dtMs * appState.replay.speed;
    if (nextMs >= appState.replay.endMs) {
        appState.replay.currentMs = appState.replay.endMs;
        renderAtCurrentTime();
        stopPlayback();
        return;
    }

    appState.replay.currentMs = nextMs;
    renderAtCurrentTime();
    appState.replay.rafId = requestAnimationFrame(playbackStep);
}

function togglePlayback() {
    if (appState.replay.playing) {
        stopPlayback();
        return;
    }

    appState.replay.playing = true;
    appState.replay.lastTick = performance.now();
    document.getElementById("play-btn").textContent = "Pause";
    appState.replay.rafId = requestAnimationFrame(playbackStep);
}

function initReplayControls() {
    const timeline = document.getElementById("timeline");
    timeline.min = String(appState.replay.startMs);
    timeline.max = String(appState.replay.endMs);
    timeline.step = "100";
    timeline.value = String(appState.replay.startMs);

    timeline.addEventListener("input", (event) => {
        appState.replay.currentMs = Number(event.target.value);
        if (appState.replay.playing) stopPlayback();
        renderAtCurrentTime();
    });

    document.getElementById("play-btn").addEventListener("click", togglePlayback);

    document.querySelectorAll(".speed-btn").forEach((btn) => {
        btn.addEventListener("click", () => setSpeed(Number(btn.dataset.speed)));
    });

    document.getElementById("pit-marker-toggle").addEventListener("change", (event) => {
        appState.showPitMarkers = event.target.checked;
        buildTimelineMarkers();
    });

    setSpeed(1);
    buildTimelineScale();
    buildTimelineMarkers();
}

function initTower() {
    const header = document.getElementById("tower-header");
    const body = document.getElementById("tower-body");

    if (appState.mode === "race") {
        header.className = "tower-header race";
        header.innerHTML = `
            <span>POS</span>
            <span></span>
            <span>DRIVER</span>
            <span>GAP</span>
            <span>INT</span>
            <span>LAP</span>
            <span>TYRE</span>
        `;
    } else {
        header.className = "tower-header timed";
        header.innerHTML = `
            <span>POS</span>
            <span></span>
            <span>DRIVER</span>
            <span>BEST</span>
            <span>P1 GAP</span>
            <span>SECTORS</span>
        `;
    }

    body.innerHTML = "";
    appState.ui.rowsByDriver.clear();
    appState.ui.prevPositions.clear();

    appState.drivers.forEach((driver) => {
        const row = document.createElement("div");
        row.className = `tower-row ${appState.mode}`;
        row.dataset.driver = String(driver.driver_number);

        const color = teamColor(driver.team_name);

        if (appState.mode === "race") {
            row.innerHTML = `
                <div class="cell pos">--</div>
                <div class="team-bar" style="background:${color}"></div>
                <div class="cell driver">
                    <span class="driver-code">${driver.name_acronym || `#${driver.driver_number}`}</span>
                    <span class="pit-icon">PIT</span>
                </div>
                <div class="cell gap">--</div>
                <div class="cell interval">--</div>
                <div class="cell lap">--</div>
                <div class="cell tyre">--</div>
            `;
        } else {
            row.innerHTML = `
                <div class="cell pos">--</div>
                <div class="team-bar" style="background:${color}"></div>
                <div class="cell driver">
                    <span class="driver-code">${driver.name_acronym || `#${driver.driver_number}`}</span>
                </div>
                <div class="cell best">
                    <div class="best-wrap">
                        <span class="best-main">--</span>
                        <span class="best-sub">Current --</span>
                    </div>
                </div>
                <div class="cell delta">--</div>
                <div class="cell current">
                    <span class="sector">S1</span>
                    <span class="sector">S2</span>
                    <span class="sector">S3</span>
                </div>
            `;
        }

        row.addEventListener("click", () => setSelectedDriver(driver.driver_number));

        body.appendChild(row);
        appState.ui.rowsByDriver.set(driver.driver_number, row);
    });

    body.style.height = `${appState.drivers.length * ROW_HEIGHT}px`;
}

function getCurrentLapRecord(series, currentMs) {
    return series.lapEndSeries.find((lap) => lap.ms <= currentMs && lap.endMs > currentMs) || null;
}

function getLeaderLap(currentMs) {
    const leaders = appState.drivers.map((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];
        const pos = latestValue(series.positionSeries, currentMs)?.position ?? 999;
        const lap = latestValue(series.lapStartSeries, currentMs)?.lapNumber ?? 0;
        return { pos, lap };
    }).sort((a, b) => a.pos - b.pos);

    return leaders.length ? leaders[0].lap : 0;
}

function renderRaceTower(currentMs) {
    const standings = appState.drivers.map((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];
        const posRec = latestValue(series.positionSeries, currentMs);
        const gapRec = latestValue(series.gapSeries, currentMs);
        const intRec = latestValue(series.intervalSeries, currentMs);
        const lapRec = latestValue(series.lapStartSeries, currentMs);
        const currentLap = getCurrentLapRecord(series, currentMs);

        return {
            driverNumber: driver.driver_number,
            position: posRec?.position ?? 999,
            gap: gapRec?.gap ?? null,
            gapRaw: gapRec?.raw ?? null,
            interval: intRec?.interval ?? null,
            lap: lapRec?.lapNumber ?? null,
            currentLap,
            tyreState: resolveTyreState(series, currentMs, lapRec?.lapNumber ?? null, currentLap),
            inPit: isDriverInPit(driver.driver_number, currentMs),
            color: teamColor(driver.team_name),
        };
    }).sort((a, b) => a.position - b.position || a.driverNumber - b.driverNumber);

    standings.forEach((entry, order) => {
        const row = appState.ui.rowsByDriver.get(entry.driverNumber);
        if (!row) return;

        row.style.transform = `translateY(${order * ROW_HEIGHT}px)`;

        const prevPos = appState.ui.prevPositions.get(entry.driverNumber);
        appState.ui.prevPositions.set(entry.driverNumber, entry.position);
        if (Number.isFinite(prevPos) && entry.position < prevPos) {
            row.style.setProperty("--pulse-color", `${entry.color}66`);
            row.classList.add("overtake");
            window.setTimeout(() => row.classList.remove("overtake"), 560);
        }

        const posEl = row.querySelector(".pos");
        const showPos = Number.isFinite(entry.position) && entry.position < 999;
        posEl.textContent = showPos ? `P${entry.position}` : "--";
        posEl.className = `cell pos ${entry.position <= 3 ? `p${entry.position}` : ""}`.trim();

        row.querySelector(".gap").textContent = formatGapValue(entry.gap, entry.gapRaw, entry.position);
        row.querySelector(".interval").textContent = formatInterval(entry.interval);
        row.querySelector(".lap").textContent = entry.lap ? `L${entry.lap}` : "--";
        row.querySelector(".tyre").innerHTML = tyreCellMarkup(entry.tyreState);
        row.querySelector(".pit-icon").classList.toggle("visible", entry.inPit);
    });
}

function sectorClass(value, fieldBest, personalBest) {
    if (!Number.isFinite(value)) return "";
    if (Number.isFinite(fieldBest) && value <= fieldBest + 0.0005) return "purple";
    if (Number.isFinite(personalBest) && value <= personalBest + 0.0005) return "green";
    return "yellow";
}

function getCompletedLaps(series, currentMs) {
    return series.lapEndSeries.filter((lap) => lap.timed && lap.endMs <= currentMs);
}

function renderTimedTower(currentMs) {
    const allCompleted = [];
    appState.drivers.forEach((driver) => {
        allCompleted.push(...getCompletedLaps(appState.indexes.byDriver[driver.driver_number], currentMs));
    });

    const fieldBestS1 = Math.min(...allCompleted.map((l) => l.s1).filter(Number.isFinite), Number.POSITIVE_INFINITY);
    const fieldBestS2 = Math.min(...allCompleted.map((l) => l.s2).filter(Number.isFinite), Number.POSITIVE_INFINITY);
    const fieldBestS3 = Math.min(...allCompleted.map((l) => l.s3).filter(Number.isFinite), Number.POSITIVE_INFINITY);

    const ranking = appState.drivers.map((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];
        const completed = getCompletedLaps(series, currentMs);
        const currentLap = getCurrentLapRecord(series, currentMs);

        const bestLap = completed.length
            ? Math.min(...completed.map((lap) => lap.lapDuration).filter(Number.isFinite))
            : null;

        const personalBestS1 = Math.min(...completed.map((l) => l.s1).filter(Number.isFinite), Number.POSITIVE_INFINITY);
        const personalBestS2 = Math.min(...completed.map((l) => l.s2).filter(Number.isFinite), Number.POSITIVE_INFINITY);
        const personalBestS3 = Math.min(...completed.map((l) => l.s3).filter(Number.isFinite), Number.POSITIVE_INFINITY);

        return {
            driverNumber: driver.driver_number,
            bestLap,
            currentLap,
            sectors: {
                s1: sectorClass(currentLap?.s1, Number.isFinite(fieldBestS1) ? fieldBestS1 : null, Number.isFinite(personalBestS1) ? personalBestS1 : null),
                s2: sectorClass(currentLap?.s2, Number.isFinite(fieldBestS2) ? fieldBestS2 : null, Number.isFinite(personalBestS2) ? personalBestS2 : null),
                s3: sectorClass(currentLap?.s3, Number.isFinite(fieldBestS3) ? fieldBestS3 : null, Number.isFinite(personalBestS3) ? personalBestS3 : null),
            },
        };
    }).sort((a, b) => {
        const av = Number.isFinite(a.bestLap) ? a.bestLap : Number.POSITIVE_INFINITY;
        const bv = Number.isFinite(b.bestLap) ? b.bestLap : Number.POSITIVE_INFINITY;
        if (av !== bv) return av - bv;
        return a.driverNumber - b.driverNumber;
    });

    const bestOverall = ranking.find((entry) => Number.isFinite(entry.bestLap))?.bestLap ?? null;

    ranking.forEach((entry, order) => {
        const row = appState.ui.rowsByDriver.get(entry.driverNumber);
        if (!row) return;

        row.style.transform = `translateY(${order * ROW_HEIGHT}px)`;

        const posEl = row.querySelector(".pos");
        const hasBest = Number.isFinite(entry.bestLap);
        posEl.textContent = hasBest ? `P${order + 1}` : "--";
        posEl.className = `cell pos ${order < 3 && hasBest ? `p${order + 1}` : ""}`.trim();

        row.querySelector(".best-main").textContent = formatLapTime(entry.bestLap);

        const currentText = entry.currentLap
            ? `Current L${entry.currentLap.lapNumber}`
            : "Current --";
        row.querySelector(".best-sub").textContent = currentText;

        const delta = hasBest && Number.isFinite(bestOverall)
            ? (entry.bestLap - bestOverall)
            : null;
        row.querySelector(".delta").textContent = delta === null || delta <= 0.0005 ? "--" : `+${delta.toFixed(3)}`;

        const sectors = row.querySelectorAll(".sector");
        sectors[0].className = `sector ${entry.sectors.s1}`.trim();
        sectors[1].className = `sector ${entry.sectors.s2}`.trim();
        sectors[2].className = `sector ${entry.sectors.s3}`.trim();
    });
}

function updateMapFlagVisual(flagState) {
    const overlay = document.getElementById("flag-overlay");

    appState.ui.sectorOverlays.forEach((sectorOverlay) => {
        sectorOverlay.className = "sector-overlay";
    });

    if (!flagState || flagState.type === "green") {
        overlay.className = "flag-overlay hidden";
        return;
    }

    overlay.textContent = `${flagState.text} ACTIVE`;
    overlay.className = `flag-overlay ${flagState.type}`;

    if (flagState.type === "yellow" && flagState.sector) {
        const idx = flagState.sector - 1;
        if (appState.ui.sectorOverlays[idx]) {
            appState.ui.sectorOverlays[idx].className = `sector-overlay active ${flagState.type}`;
        }
        return;
    }

    appState.ui.sectorOverlays.forEach((sectorOverlay) => {
        sectorOverlay.className = `sector-overlay active ${flagState.type}`;
    });
}

function updateFlagBadge(flagState, leaderLap) {
    const badge = document.getElementById("flag-badge");
    badge.className = "flag-badge";

    if (!flagState || flagState.type === "green") {
        badge.textContent = "GREEN";
        return;
    }

    if (flagState.type === "sc") {
        badge.textContent = leaderLap ? `SC LAP ${leaderLap}` : "SC";
    } else {
        badge.textContent = flagState.text;
    }
    badge.classList.add(flagState.type);
}

function updatePitBoard(currentMs) {
    const pitList = document.getElementById("pit-list");
    const active = appState.drivers
        .filter((driver) => isDriverInPit(driver.driver_number, currentMs))
        .map((driver) => ({
            code: driver.name_acronym || `#${driver.driver_number}`,
            color: teamColor(driver.team_name),
        }));

    if (!active.length) {
        pitList.innerHTML = `<div class="pit-empty">No drivers in pit lane</div>`;
        return;
    }

    pitList.innerHTML = active.map((item) => `
        <div class="pit-item">
            <span class="pit-item-code" style="color:${item.color}">${item.code}</span>
            <span>PIT</span>
        </div>
    `).join("");
}

function renderMapDrivers(currentMs) {
    appState.drivers.forEach((driver) => {
        const dot = appState.ui.dotsByDriver.get(driver.driver_number);
        if (!dot) return;

        const series = appState.indexes.byDriver[driver.driver_number].locationSeriesNormalized || [];
        const point = getInterpolatedPoint(series, currentMs);

        if (!point) {
            dot.style.opacity = "0";
            return;
        }

        dot.style.opacity = "1";
        dot.setAttribute("transform", `translate(${point.x.toFixed(2)} ${point.y.toFixed(2)})`);
    });
}

function formatMetaText(currentSec, leaderLap) {
    const elapsedSec = Math.max(0, (appState.replay.currentMs - appState.replay.startMs) / 1000);
    if (appState.mode === "race") {
        const totalLap = Math.max(1, appState.indexes.maxLapNumber || 1);
        const lapText = leaderLap ? `L${leaderLap}` : "L--";
        return `${lapText} / L${totalLap}`;
    }
    return `${formatElapsed(elapsedSec)} / ${formatElapsed(appState.replay.durationMs / 1000)}`;
}

function renderAtCurrentTime() {
    const currentMs = Math.max(appState.replay.startMs, Math.min(appState.replay.endMs, Math.round(appState.replay.currentMs)));
    appState.replay.currentMs = currentMs;
    const timeline = document.getElementById("timeline");
    timeline.value = String(currentMs);

    document.getElementById("clock-label").textContent = formatClockTime(currentMs);

    let leaderLap = 0;
    if (appState.mode === "race") {
        renderRaceTower(currentMs);
        leaderLap = getLeaderLap(currentMs);
    } else {
        renderTimedTower(currentMs);
        leaderLap = appState.drivers
            .map((driver) => latestValue(appState.indexes.byDriver[driver.driver_number].lapStartSeries, currentMs)?.lapNumber ?? 0)
            .sort((a, b) => b - a)[0] || 0;
    }

    document.getElementById("lap-label").textContent = leaderLap ? `Lap ${leaderLap}` : "Lap --";
    document.getElementById("timeline-meta").textContent = formatMetaText(currentMs, leaderLap);

    renderMapDrivers(currentMs);
    updatePitBoard(currentMs);

    const flagState = getActiveFlag(currentMs);
    updateMapFlagVisual(flagState);
    updateFlagBadge(flagState, leaderLap);
}

function fillHeaderMeta() {
    const info = appState.sessionInfo || {};
    const sessionName = info.session_name || info.session_type || `Session ${SESSION_KEY}`;
    const date = info.date_start ? new Date(info.date_start).toLocaleDateString("en-GB") : "Date n/a";
    const location = info.location || info.country_name || "OpenF1";

    document.getElementById("session-meta").textContent = `${sessionName} - ${location} - ${date}`;
}

function configureModeUi() {
    const towerTitle = document.getElementById("tower-title");
    const towerSub = document.getElementById("tower-sub");
    const mapSub = document.getElementById("map-sub");

    if (appState.mode === "race") {
        towerTitle.textContent = "Race Timing Board";
        towerSub.textContent = "Position, gap, interval, lap and tyre status";
        mapSub.textContent = "Track position replay with race control state overlays";
    } else {
        towerTitle.textContent = "Qualifying Tower";
        towerSub.textContent = "Best laps, delta to P1, and live sector colors";
        mapSub.textContent = "Track position replay with timed-session evolution";
    }
}

async function loadSessionView() {
    showStatus("Fetching OpenF1 datasets for replay...");

    const [
        sessionResult,
        driversResult,
        positionsResult,
        lapsResult,
        intervalsResult,
        locationResult,
        stintsResult,
        raceControlResult,
    ] = await Promise.allSettled([
        apiFetch("/api/session_info", { session_key: SESSION_KEY }),
        apiFetch("/api/drivers", { session_key: SESSION_KEY }),
        apiFetch("/api/positions", { session_key: SESSION_KEY }),
        apiFetch("/api/laps", { session_key: SESSION_KEY }),
        apiFetch("/api/intervals", { session_key: SESSION_KEY }),
        apiFetch("/api/location", { session_key: SESSION_KEY }),
        apiFetch("/api/stints", { session_key: SESSION_KEY }),
        apiFetch("/api/race_control", { session_key: SESSION_KEY }),
    ]);

    if (driversResult.status === "rejected") {
        throw driversResult.reason;
    }

    if (positionsResult.status === "rejected" && lapsResult.status === "rejected" && locationResult.status === "rejected") {
        throw new Error("Session datasets unavailable. Position, lap and location feeds failed.");
    }

    appState.sessionInfo = sessionResult.status === "fulfilled" ? sessionResult.value : {};
    appState.mode = sessionMode(appState.sessionInfo);

    appState.drivers = (driversResult.value || []).sort((a, b) => a.driver_number - b.driver_number);
    appState.driverMap = {};
    appState.driverByAcronym = {};
    appState.drivers.forEach((driver) => {
        appState.driverMap[driver.driver_number] = driver;
        if (driver.name_acronym) {
            appState.driverByAcronym[driver.name_acronym.toUpperCase()] = driver;
        }
    });

    const positions = positionsResult.status === "fulfilled" ? positionsResult.value : [];
    const laps = lapsResult.status === "fulfilled" ? lapsResult.value : [];
    const intervals = intervalsResult.status === "fulfilled" ? intervalsResult.value : [];
    const locations = locationResult.status === "fulfilled" ? locationResult.value : [];
    const stints = stintsResult.status === "fulfilled" ? stintsResult.value : [];
    const raceControl = raceControlResult.status === "fulfilled" ? raceControlResult.value : [];

    appState.indexes = buildIndexes(appState.drivers, positions, laps, intervals, locations, stints);

    appState.replay.startMs = appState.indexes.startMs;
    appState.replay.endMs = Math.max(appState.indexes.endMs, appState.indexes.startMs + 1000);
    appState.replay.durationMs = Math.max(1000, appState.replay.endMs - appState.replay.startMs);
    appState.replay.currentMs = appState.replay.startMs;

    const rc = buildRaceControlEvents(raceControl, appState.replay.startMs, appState.replay.endMs);
    appState.raceControlEvents = rc.events;
    appState.timelineMarkers = rc.markers;

    appState.trackModel = buildTrackModel(appState.indexes);

    fillHeaderMeta();
    configureModeUi();
    initMap();
    initTower();
    initReplayControls();

    document.getElementById("session-shell").classList.remove("hidden");
    hideStatus();
    renderAtCurrentTime();
}

document.addEventListener("DOMContentLoaded", async () => {
    try {
        await loadSessionView();
    } catch (err) {
        showStatus(`Error: ${err?.message || "Unknown error"}`, "error");
    }
});
