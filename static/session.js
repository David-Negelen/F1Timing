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

const ROW_HEIGHT = 44;

const appState = {
    mode: "race",
    sessionInfo: null,
    drivers: [],
    driverMap: {},
    indexes: {},
    replay: {
        startMs: 0,
        endMs: 0,
        durationSec: 0,
        currentSec: 0,
        playing: false,
        speed: 1,
        rafId: null,
        lastTick: 0,
    },
    ui: {
        rowsByDriver: new Map(),
        prevPositions: new Map(),
    },
};

async function apiFetch(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== null && v !== undefined) {
            url.searchParams.set(k, v);
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
    if (!teamName) return "#6e6e7c";
    const key = Object.keys(TEAM_COLORS).find((item) =>
        teamName.toLowerCase().includes(item.toLowerCase())
    );
    return key ? TEAM_COLORS[key] : "#6e6e7c";
}

function parseTimeMs(value) {
    if (!value) return null;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
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

function isTimedLap(lap) {
    if (!lap) return false;
    if (lap.is_pit_out_lap) return false;
    if (!Number.isFinite(lap.lap_duration)) return false;
    if (lap.lap_duration <= 45 || lap.lap_duration >= 180) return false;
    return true;
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

function formatInterval(raw) {
    if (raw === null || raw === undefined || raw === "") return "--";
    if (typeof raw === "number") return `+${raw.toFixed(3)}`;
    const text = String(raw).trim();
    return text ? text.toUpperCase() : "--";
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

function valuesUpTo(series, ms) {
    if (!series.length) return [];
    const idx = latestIndexAtOrBefore(series, ms);
    return idx >= 0 ? series.slice(0, idx + 1) : [];
}

function sessionMode(sessionInfo) {
    const type = String(sessionInfo?.session_type || sessionInfo?.session_name || "").toLowerCase();
    if (type.includes("race") || type.includes("sprint")) return "race";
    return "timed";
}

function buildIndexes(drivers, positions, laps, intervals) {
    const byDriver = {};

    drivers.forEach((driver) => {
        byDriver[driver.driver_number] = {
            positionSeries: [],
            gapSeries: [],
            intervalSeries: [],
            lapStartSeries: [],
            lapEndSeries: [],
            pitEvents: [],
        };
    });

    positions.forEach((item) => {
        if (item.driver_number == null || item.position == null) return;
        const ms = parseTimeMs(item.date);
        if (ms === null) return;

        const bucket = byDriver[item.driver_number];
        if (!bucket) return;

        bucket.positionSeries.push({ ms, position: Number(item.position) });
    });

    intervals.forEach((item) => {
        if (item.driver_number == null) return;
        const ms = parseTimeMs(item.date);
        if (ms === null) return;

        const bucket = byDriver[item.driver_number];
        if (!bucket) return;

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
        const startMs = parseTimeMs(item.date_start);
        if (startMs === null) return;

        const duration = Number(item.lap_duration);
        const endMs = Number.isFinite(duration) ? startMs + Math.round(duration * 1000) : startMs;

        const bucket = byDriver[item.driver_number];
        if (!bucket) return;

        const lapRecord = {
            ms: startMs,
            endMs,
            lapNumber: Number(item.lap_number),
            lapDuration: Number.isFinite(duration) ? duration : null,
            s1: Number.isFinite(item.duration_sector_1) ? item.duration_sector_1 : null,
            s2: Number.isFinite(item.duration_sector_2) ? item.duration_sector_2 : null,
            s3: Number.isFinite(item.duration_sector_3) ? item.duration_sector_3 : null,
            isPitOut: Boolean(item.is_pit_out_lap),
            timed: isTimedLap(item),
        };

        bucket.lapStartSeries.push({ ms: startMs, lapNumber: lapRecord.lapNumber });
        bucket.lapEndSeries.push(lapRecord);
        if (lapRecord.isPitOut) {
            bucket.pitEvents.push({ ms: endMs, lapNumber: lapRecord.lapNumber });
        }
    });

    Object.values(byDriver).forEach((driverData) => {
        driverData.positionSeries.sort((a, b) => a.ms - b.ms);
        driverData.gapSeries.sort((a, b) => a.ms - b.ms);
        driverData.intervalSeries.sort((a, b) => a.ms - b.ms);
        driverData.lapStartSeries.sort((a, b) => a.ms - b.ms);
        driverData.lapEndSeries.sort((a, b) => a.endMs - b.endMs);
        driverData.pitEvents.sort((a, b) => a.ms - b.ms);
    });

    const allTimes = [];

    Object.values(byDriver).forEach((driverData) => {
        driverData.positionSeries.forEach((x) => allTimes.push(x.ms));
        driverData.gapSeries.forEach((x) => allTimes.push(x.ms));
        driverData.lapStartSeries.forEach((x) => allTimes.push(x.ms));
        driverData.lapEndSeries.forEach((x) => allTimes.push(x.endMs));
    });

    const startMs = allTimes.length ? Math.min(...allTimes) : Date.now();
    const endMs = allTimes.length ? Math.max(...allTimes) : startMs;

    return {
        byDriver,
        startMs,
        endMs,
    };
}

function buildTimelineScale() {
    const scale = document.getElementById("timeline-scale");
    const duration = appState.replay.durationSec;

    const tickCount = 6;
    const ticks = [];
    for (let i = 0; i <= tickCount; i += 1) {
        const sec = Math.round((duration * i) / tickCount);
        ticks.push(`<span>${formatElapsed(sec)}</span>`);
    }

    scale.innerHTML = ticks.join("");
}

function setSpeed(speed) {
    appState.replay.speed = speed;
    document.querySelectorAll(".speed-btn").forEach((btn) => {
        btn.classList.toggle("active", Number(btn.dataset.speed) === speed);
    });
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

    const deltaSec = (dtMs / 1000) * appState.replay.speed;
    const nextSec = appState.replay.currentSec + deltaSec;

    if (nextSec >= appState.replay.durationSec) {
        appState.replay.currentSec = appState.replay.durationSec;
        renderAtCurrentTime();
        stopPlayback();
        return;
    }

    appState.replay.currentSec = nextSec;
    renderAtCurrentTime();
    appState.replay.rafId = requestAnimationFrame(playbackStep);
}

function initTower() {
    const header = document.getElementById("tower-header");
    const body = document.getElementById("tower-body");

    if (appState.mode === "race") {
        header.innerHTML = `
            <span>POS</span>
            <span>DRIVER</span>
            <span>LAP</span>
            <span>GAP</span>
            <span>INT</span>
        `;
    } else {
        header.innerHTML = `
            <span>POS</span>
            <span>DRIVER</span>
            <span>BEST</span>
            <span>CURRENT</span>
            <span>SECTORS</span>
        `;
    }

    body.innerHTML = "";
    appState.ui.rowsByDriver.clear();
    appState.ui.prevPositions.clear();

    appState.drivers.forEach((driver) => {
        const row = document.createElement("div");
        row.className = "tower-row";
        row.dataset.driver = String(driver.driver_number);

        if (appState.mode === "race") {
            row.innerHTML = `
                <div class="cell pos">--</div>
                <div class="cell driver">
                    <span class="team-dot" style="background:${teamColor(driver.team_name)}"></span>
                    <span class="code">${driver.name_acronym || `#${driver.driver_number}`}</span>
                </div>
                <div class="cell lap">--</div>
                <div class="cell gap">--</div>
                <div class="cell interval">--</div>
            `;
        } else {
            row.innerHTML = `
                <div class="cell pos">--</div>
                <div class="cell driver">
                    <span class="team-dot" style="background:${teamColor(driver.team_name)}"></span>
                    <span class="code">${driver.name_acronym || `#${driver.driver_number}`}</span>
                </div>
                <div class="cell best">--</div>
                <div class="cell current">--</div>
                <div class="cell sectors">
                    <span class="sector">S1</span>
                    <span class="sector">S2</span>
                    <span class="sector">S3</span>
                </div>
            `;
        }

        body.appendChild(row);
        appState.ui.rowsByDriver.set(driver.driver_number, row);
    });

    body.style.height = `${appState.drivers.length * ROW_HEIGHT}px`;
}

function renderRaceTower(currentMs) {
    const standings = appState.drivers.map((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];

        const posRec = latestValue(series.positionSeries, currentMs);
        const lapRec = latestValue(series.lapStartSeries, currentMs);
        const gapRec = latestValue(series.gapSeries, currentMs);
        const intRec = latestValue(series.intervalSeries, currentMs);

        return {
            driverNumber: driver.driver_number,
            position: posRec?.position ?? 999,
            lap: lapRec?.lapNumber ?? null,
            gap: gapRec?.gap ?? null,
            rawGap: gapRec?.raw ?? null,
            interval: intRec?.interval ?? null,
        };
    }).sort((a, b) => a.position - b.position || a.driverNumber - b.driverNumber);

    standings.forEach((entry, order) => {
        const row = appState.ui.rowsByDriver.get(entry.driverNumber);
        if (!row) return;

        row.style.transform = `translateY(${order * ROW_HEIGHT}px)`;

        const prevPos = appState.ui.prevPositions.get(entry.driverNumber);
        appState.ui.prevPositions.set(entry.driverNumber, entry.position);
        if (Number.isFinite(prevPos) && entry.position < prevPos) {
            row.classList.add("overtake");
            window.setTimeout(() => row.classList.remove("overtake"), 550);
        }

        row.querySelector(".pos").textContent = Number.isFinite(entry.position) && entry.position < 999
            ? String(entry.position)
            : "--";
        row.querySelector(".lap").textContent = entry.lap == null ? "--" : `L${entry.lap}`;
        row.querySelector(".gap").textContent = formatGap(entry.gap, entry.position);
        row.querySelector(".interval").textContent = formatInterval(entry.interval);

        row.classList.toggle("leader", entry.position === 1);
    });
}

function getCompletedTimedLaps(series, currentMs) {
    return series.lapEndSeries.filter((lap) => lap.timed && lap.endMs <= currentMs);
}

function findCurrentLap(series, currentMs) {
    const lap = series.lapEndSeries.find((item) => item.ms <= currentMs && item.endMs > currentMs);
    return lap || null;
}

function sectorClass(value, fieldBest, driverBest) {
    if (!Number.isFinite(value)) return "";
    if (Number.isFinite(fieldBest) && value <= fieldBest + 0.0005) return "purple";
    if (Number.isFinite(driverBest) && value <= driverBest + 0.0005) return "green";
    return "yellow";
}

function renderTimedTower(currentMs) {
    const allCompleted = [];

    appState.drivers.forEach((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];
        allCompleted.push(...getCompletedTimedLaps(series, currentMs));
    });

    const fieldBestS1 = allCompleted.length ? Math.min(...allCompleted.map((l) => l.s1).filter(Number.isFinite)) : null;
    const fieldBestS2 = allCompleted.length ? Math.min(...allCompleted.map((l) => l.s2).filter(Number.isFinite)) : null;
    const fieldBestS3 = allCompleted.length ? Math.min(...allCompleted.map((l) => l.s3).filter(Number.isFinite)) : null;

    const ranking = appState.drivers.map((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];
        const completed = getCompletedTimedLaps(series, currentMs);
        const currentLap = findCurrentLap(series, currentMs);

        const bestLap = completed.length
            ? Math.min(...completed.map((lap) => lap.lapDuration).filter(Number.isFinite))
            : null;

        const personalBestS1 = completed.length ? Math.min(...completed.map((lap) => lap.s1).filter(Number.isFinite)) : null;
        const personalBestS2 = completed.length ? Math.min(...completed.map((lap) => lap.s2).filter(Number.isFinite)) : null;
        const personalBestS3 = completed.length ? Math.min(...completed.map((lap) => lap.s3).filter(Number.isFinite)) : null;

        return {
            driverNumber: driver.driver_number,
            bestLap,
            currentLap,
            sectorClasses: {
                s1: sectorClass(currentLap?.s1, fieldBestS1, personalBestS1),
                s2: sectorClass(currentLap?.s2, fieldBestS2, personalBestS2),
                s3: sectorClass(currentLap?.s3, fieldBestS3, personalBestS3),
            },
        };
    }).sort((a, b) => {
        const av = Number.isFinite(a.bestLap) ? a.bestLap : Number.POSITIVE_INFINITY;
        const bv = Number.isFinite(b.bestLap) ? b.bestLap : Number.POSITIVE_INFINITY;
        if (av !== bv) return av - bv;
        return a.driverNumber - b.driverNumber;
    });

    ranking.forEach((entry, order) => {
        const row = appState.ui.rowsByDriver.get(entry.driverNumber);
        if (!row) return;

        row.style.transform = `translateY(${order * ROW_HEIGHT}px)`;

        row.querySelector(".pos").textContent = Number.isFinite(entry.bestLap) ? String(order + 1) : "--";
        row.querySelector(".best").textContent = formatLapTime(entry.bestLap);
        row.querySelector(".current").textContent = entry.currentLap ? `L${entry.currentLap.lapNumber}` : "--";

        const sectors = row.querySelectorAll(".sector");
        sectors[0].className = `sector ${entry.sectorClasses.s1}`.trim();
        sectors[1].className = `sector ${entry.sectorClasses.s2}`.trim();
        sectors[2].className = `sector ${entry.sectorClasses.s3}`.trim();
    });
}

function svgEl(name, attrs = {}) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.entries(attrs).forEach(([key, value]) => {
        el.setAttribute(key, String(value));
    });
    return el;
}

function clearChart() {
    const chart = document.getElementById("main-chart");
    chart.innerHTML = "";
    return chart;
}

function chartPoint(x, y, width, height, maxX, maxY) {
    const px = 60 + (x / Math.max(1, maxX)) * (width - 80);
    const py = 20 + (1 - (y / Math.max(0.0001, maxY))) * (height - 70);
    return { px, py };
}

function drawAxes(chart, width, height, yLabel) {
    chart.appendChild(svgEl("line", { x1: 60, y1: 20, x2: 60, y2: height - 50, class: "axis-line" }));
    chart.appendChild(svgEl("line", { x1: 60, y1: height - 50, x2: width - 20, y2: height - 50, class: "axis-line" }));

    chart.appendChild(svgEl("text", {
        x: 16,
        y: 24,
        class: "axis-text",
    })).textContent = yLabel;

    chart.appendChild(svgEl("text", {
        x: width - 70,
        y: height - 18,
        class: "axis-text",
    })).textContent = "time";
}

function renderGapChart(currentMs) {
    const chart = clearChart();
    const width = 900;
    const height = 420;

    const spanMs = Math.max(1, appState.indexes.endMs - appState.indexes.startMs);

    const allVisible = [];
    appState.drivers.forEach((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number].gapSeries;
        valuesUpTo(series, currentMs).forEach((p) => {
            if (Number.isFinite(p.gap)) allVisible.push(p.gap);
        });
    });

    const maxGap = allVisible.length ? Math.max(...allVisible) : 1;
    drawAxes(chart, width, height, "gap");

    appState.drivers.forEach((driver) => {
        const series = appState.indexes.byDriver[driver.driver_number];
        const points = valuesUpTo(series.gapSeries, currentMs)
            .filter((item) => Number.isFinite(item.gap))
            .map((item) => {
                const x = item.ms - appState.indexes.startMs;
                return chartPoint(x, item.gap, width, height, spanMs, maxGap);
            });

        if (points.length < 2) return;

        const polyline = svgEl("polyline", {
            points: points.map((p) => `${p.px},${p.py}`).join(" "),
            fill: "none",
            stroke: teamColor(driver.team_name),
            "stroke-width": 2.1,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            opacity: 0.95,
        });
        chart.appendChild(polyline);

        const pitPoints = valuesUpTo(series.pitEvents, currentMs);
        pitPoints.forEach((pit) => {
            const gapAtPit = latestValue(series.gapSeries, pit.ms);
            const yVal = Number.isFinite(gapAtPit?.gap) ? gapAtPit.gap : 0;
            const point = chartPoint(pit.ms - appState.indexes.startMs, yVal, width, height, spanMs, maxGap);
            chart.appendChild(svgEl("circle", {
                cx: point.px,
                cy: point.py,
                r: 3.2,
                class: "pit-marker",
            }));
        });
    });
}

function renderLapDistributionChart(currentMs) {
    const chart = clearChart();
    const width = 900;
    const height = 420;
    const spanMs = Math.max(1, appState.indexes.endMs - appState.indexes.startMs);

    const points = [];
    appState.drivers.forEach((driver) => {
        const laps = valuesUpTo(appState.indexes.byDriver[driver.driver_number].lapEndSeries, currentMs)
            .filter((lap) => lap.timed && Number.isFinite(lap.lapDuration));

        laps.forEach((lap) => {
            points.push({
                driver,
                xMs: lap.endMs - appState.indexes.startMs,
                y: lap.lapDuration,
            });
        });
    });

    const yValues = points.map((p) => p.y);
    const minLap = yValues.length ? Math.min(...yValues) : 60;
    const maxLap = yValues.length ? Math.max(...yValues) : 120;
    const spanLap = Math.max(1, maxLap - minLap);

    drawAxes(chart, width, height, "lap");

    points.forEach((point) => {
        const px = 60 + (point.xMs / spanMs) * (width - 80);
        const py = 20 + (1 - ((point.y - minLap) / spanLap)) * (height - 70);
        chart.appendChild(svgEl("circle", {
            cx: px,
            cy: py,
            r: 3.1,
            fill: teamColor(point.driver.team_name),
            opacity: 0.88,
        }));
    });
}

function renderAtCurrentTime() {
    const currentMs = appState.indexes.startMs + Math.round(appState.replay.currentSec * 1000);

    document.getElementById("timeline").value = String(Math.floor(appState.replay.currentSec));
    document.getElementById("clock-label").textContent = formatClockTime(currentMs);
    document.getElementById("timeline-meta").textContent = `${formatElapsed(appState.replay.currentSec)} / ${formatElapsed(appState.replay.durationSec)}`;

    let leaderLap = "--";

    if (appState.mode === "race") {
        renderRaceTower(currentMs);
        renderGapChart(currentMs);

        const leader = appState.drivers
            .map((driver) => {
                const d = appState.indexes.byDriver[driver.driver_number];
                const pos = latestValue(d.positionSeries, currentMs)?.position ?? 999;
                const lap = latestValue(d.lapStartSeries, currentMs)?.lapNumber ?? null;
                return { pos, lap };
            })
            .sort((a, b) => a.pos - b.pos)[0];
        if (leader && leader.lap != null) leaderLap = String(leader.lap);
    } else {
        renderTimedTower(currentMs);
        renderLapDistributionChart(currentMs);

        const mostAdvanced = appState.drivers
            .map((driver) => latestValue(appState.indexes.byDriver[driver.driver_number].lapStartSeries, currentMs)?.lapNumber ?? 0)
            .sort((a, b) => b - a)[0];
        if (mostAdvanced) leaderLap = String(mostAdvanced);
    }

    document.getElementById("lap-label").textContent = `Lap ${leaderLap}`;
}

function initReplayControls() {
    const timeline = document.getElementById("timeline");
    timeline.min = "0";
    timeline.max = String(Math.floor(appState.replay.durationSec));
    timeline.step = "1";
    timeline.value = "0";

    document.getElementById("play-btn").addEventListener("click", togglePlayback);

    timeline.addEventListener("input", (event) => {
        appState.replay.currentSec = Number(event.target.value);
        if (appState.replay.playing) stopPlayback();
        renderAtCurrentTime();
    });

    document.querySelectorAll(".speed-btn").forEach((button) => {
        button.addEventListener("click", () => {
            setSpeed(Number(button.dataset.speed));
        });
    });

    buildTimelineScale();
    setSpeed(1);
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
    const chartTitle = document.getElementById("chart-title");
    const chartSub = document.getElementById("chart-sub");

    if (appState.mode === "race") {
        towerTitle.textContent = "Live Leaderboard";
        towerSub.textContent = "Position, gap to leader, and interval to car ahead";
        chartTitle.textContent = "Gap Chart";
        chartSub.textContent = "All drivers vs session leader with pit markers";
    } else {
        towerTitle.textContent = "Best Lap Tower";
        towerSub.textContent = "Resorts whenever a new personal best is set";
        chartTitle.textContent = "Lap Time Distribution";
        chartSub.textContent = "All timed laps set so far by replay time";
    }
}

async function loadSessionView() {
    showStatus("Fetching OpenF1 session datasets...");

    const [
        sessionResult,
        driversResult,
        positionsResult,
        lapsResult,
        intervalsResult,
    ] = await Promise.allSettled([
        apiFetch("/api/session_info", { session_key: SESSION_KEY }),
        apiFetch("/api/drivers", { session_key: SESSION_KEY }),
        apiFetch("/api/positions", { session_key: SESSION_KEY }),
        apiFetch("/api/laps", { session_key: SESSION_KEY }),
        apiFetch("/api/intervals", { session_key: SESSION_KEY }),
    ]);

    if (driversResult.status === "rejected") {
        throw driversResult.reason;
    }

    if (positionsResult.status === "rejected" && lapsResult.status === "rejected") {
        throw new Error("Session data unavailable. OpenF1 position and lap feeds failed.");
    }

    appState.sessionInfo = sessionResult.status === "fulfilled" ? sessionResult.value : {};
    appState.drivers = driversResult.value || [];

    appState.driverMap = {};
    appState.drivers.forEach((driver) => {
        appState.driverMap[driver.driver_number] = driver;
    });

    const positions = positionsResult.status === "fulfilled" ? positionsResult.value : [];
    const laps = lapsResult.status === "fulfilled" ? lapsResult.value : [];
    const intervals = intervalsResult.status === "fulfilled" ? intervalsResult.value : [];

    appState.mode = sessionMode(appState.sessionInfo);
    appState.indexes = buildIndexes(appState.drivers, positions, laps, intervals);

    appState.replay.startMs = appState.indexes.startMs;
    appState.replay.endMs = appState.indexes.endMs;
    appState.replay.durationSec = Math.max(1, Math.floor((appState.replay.endMs - appState.replay.startMs) / 1000));
    appState.replay.currentSec = 0;

    fillHeaderMeta();
    configureModeUi();
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
        const message = err?.message || "Unknown error";
        showStatus(`Error: ${message}`, "error");
    }
});
