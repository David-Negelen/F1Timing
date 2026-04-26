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
    "RB": "#3671C6",
    "Audi": "#BB0A30",
    "Cadillac": "#003A8F",
};

let selectedDriverNumber = null;
let lapUiState = null;
let replayState = null;

function teamColor(teamName) {
    if (!teamName) return "#555";
    const key = Object.keys(TEAM_COLORS).find(k =>
        teamName.toLowerCase().includes(k.toLowerCase())
    );
    return key ? TEAM_COLORS[key] : "#555";
}

async function apiFetch(path, params = {}) {
    const url = new URL(path, window.location.origin);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== null && v !== undefined) url.searchParams.set(k, v);
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

async function loadStandings() {
    showStatus("Fetching session data…");
    const wrap = document.getElementById("standings-wrap");
    const replayPanel = document.getElementById("replay-panel");
    wrap.innerHTML = "";
    replayPanel.innerHTML = "";
    replayPanel.classList.add("hidden");

    try {
        const [driversResult, positionsResult, lapsResult, intervalsResult] = await Promise.allSettled([
            apiFetch("/api/drivers", { session_key: SESSION_KEY }),
            apiFetch("/api/positions", { session_key: SESSION_KEY }),
            apiFetch("/api/laps", { session_key: SESSION_KEY }),
            apiFetch("/api/intervals", { session_key: SESSION_KEY }),
        ]);

        if (driversResult.status === "rejected" || positionsResult.status === "rejected") {
            const err = driversResult.status === "rejected"
                ? driversResult.reason
                : positionsResult.reason;
            throw err;
        }

        const drivers = driversResult.value;
        const positions = positionsResult.value;
        const laps = lapsResult.status === "fulfilled" ? lapsResult.value : [];
        const intervals = intervalsResult.status === "fulfilled" ? intervalsResult.value : [];

        hideStatus();

        const driverMap = {};
        drivers.forEach(d => { driverMap[d.driver_number] = d; });

        const finalPositions = getLastPositionPerDriver(positions);

        finalPositions.sort((a, b) => a.position - b.position);

        if (drivers[0]) {
            document.getElementById("session-meta").textContent =
                `Session ${SESSION_KEY} · ${drivers.length} drivers`;
        }

        renderStandings(finalPositions, driverMap);
        initReplayPanel(drivers, positions, laps, intervals);
        if (lapsResult.status === "fulfilled") {
            renderLapTimes(laps, driverMap);
        } else {
            renderInlineNotice("Lap data is temporarily unavailable due to API limits.");
        }

    } catch (err) {
        showStatus(`Error: ${err.message}`, "error");
    }
}


function getLastPositionPerDriver(positions) {
    const last = {};
    positions.forEach(p => {
        last[p.driver_number] = p;
    });
    return Object.values(last);
}


function renderStandings(finalPositions, driverMap) {
    const wrap = document.getElementById("standings-wrap");

    const table = document.createElement("table");
    table.className = "standings-table";
    table.innerHTML = `
        <thead>
        <tr>
            <th>POS</th>
            <th>DRIVER</th>
            <th>#</th>
            <th>TEAM</th>
        </tr>
        </thead>
    `;

    const tbody = document.createElement("tbody");

    finalPositions.forEach(entry => {
        const driver = driverMap[entry.driver_number] || {};
        const pos = entry.position;
        const color = teamColor(driver.team_name);

        const posClass = pos === 1 ? "pos pos-1" : pos === 2 ? "pos pos-2" : pos === 3 ? "pos pos-3" : "pos";

        const row = document.createElement("tr");
        row.className = "driver-row";
        row.dataset.driverNumber = String(entry.driver_number);
        row.innerHTML = `
            <td class="${posClass}">${pos}</td>
            <td>
                <div class="driver-cell">
                <div class="team-stripe" style="background:${color}"></div>
                <div>
                    <div class="driver-code">${driver.name_acronym || "—"}</div>
                    <div class="driver-full">${driver.full_name || ""}</div>
                </div>
                </div>
            </td>
            <td class="mono-cell">${entry.driver_number}</td>
            <td class="team-name-cell">${driver.team_name || "—"}</td>
            `;

        row.addEventListener("click", () => {
            if (!lapUiState || !lapUiState.lapsByDriver[entry.driver_number]) return;
            if (selectedDriverNumber === entry.driver_number) {
                collapseLapExpansion();
                return;
            }
            setSelectedDriver(entry.driver_number);
        });

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
}

function renderInlineNotice(message) {
    const wrap = document.getElementById("standings-wrap");
    const note = document.createElement("div");
    note.className = "inline-notice";
    note.textContent = message;
    wrap.appendChild(note);
}

function formatReplayTime(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "UTC",
    }) + " UTC";
}

function pickGapValue(intervalEntry) {
    if (!intervalEntry) return null;
    const raw = intervalEntry.gap_to_leader
        ?? intervalEntry.interval_to_leader
        ?? intervalEntry.interval
        ?? intervalEntry.gap
        ?? null;

    if (raw === null || raw === undefined || raw === "") return null;

    if (typeof raw === "number") return raw;

    const str = String(raw).trim();
    if (!str) return null;
    const numeric = Number(str.replace("+", ""));
    return Number.isFinite(numeric) ? numeric : str;
}

function formatGapValue(value, position) {
    if (position === 1) return "LEADER";
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "number") return value <= 0 ? "LEADER" : `+${value.toFixed(3)}s`;
    return String(value).toUpperCase();
}

function buildReplayFrames(positions, laps, intervals) {
    const positionEvents = new Map();
    const lapEvents = new Map();
    const gapEvents = new Map();
    const allTimestamps = new Set();

    positions.forEach(p => {
        if (!p?.date || p.driver_number == null || p.position == null) return;
        const ts = p.date;
        if (!positionEvents.has(ts)) positionEvents.set(ts, []);
        positionEvents.get(ts).push({
            driverNumber: p.driver_number,
            position: p.position,
        });
        allTimestamps.add(ts);
    });

    laps.forEach(l => {
        if (!l?.date_start || l.driver_number == null || l.lap_number == null) return;
        const ts = l.date_start;
        if (!lapEvents.has(ts)) lapEvents.set(ts, []);
        lapEvents.get(ts).push({
            driverNumber: l.driver_number,
            lapNumber: l.lap_number,
        });
        allTimestamps.add(ts);
    });

    intervals.forEach(i => {
        if (!i?.date || i.driver_number == null) return;
        const gap = pickGapValue(i);
        if (gap === null) return;
        const ts = i.date;
        if (!gapEvents.has(ts)) gapEvents.set(ts, []);
        gapEvents.get(ts).push({
            driverNumber: i.driver_number,
            gap,
        });
        allTimestamps.add(ts);
    });

    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) =>
        new Date(a).getTime() - new Date(b).getTime()
    );
    if (!sortedTimestamps.length) return [];

    const maxFrames = 1200;
    const step = Math.max(1, Math.ceil(sortedTimestamps.length / maxFrames));
    const selectedTimestamps = new Set(
        sortedTimestamps.filter((_, idx) => idx % step === 0 || idx === sortedTimestamps.length - 1)
    );

    const currentPositions = new Map();
    const currentLaps = new Map();
    const currentGaps = new Map();
    const frames = [];

    sortedTimestamps.forEach(ts => {
        (positionEvents.get(ts) || []).forEach(event => {
            currentPositions.set(event.driverNumber, event.position);
        });
        (lapEvents.get(ts) || []).forEach(event => {
            currentLaps.set(event.driverNumber, event.lapNumber);
        });
        (gapEvents.get(ts) || []).forEach(event => {
            currentGaps.set(event.driverNumber, event.gap);
        });

        if (!selectedTimestamps.has(ts)) return;

        const standings = Array.from(currentPositions.entries())
            .map(([driverNumber, position]) => ({
                driverNumber,
                position,
                lapNumber: currentLaps.get(driverNumber) ?? null,
                gap: currentGaps.get(driverNumber) ?? null,
            }))
            .sort((a, b) => a.position - b.position);

        if (!standings.length) return;

        const leader = standings.find(s => s.position === 1);
        frames.push({
            timestamp: ts,
            leaderLap: leader?.lapNumber ?? null,
            standings,
        });
    });

    return frames;
}

function toggleReplayPlayback() {
    if (!replayState) return;

    if (replayState.timer) {
        clearInterval(replayState.timer);
        replayState.timer = null;
        replayState.playButton.textContent = "Play";
        return;
    }

    replayState.playButton.textContent = "Pause";
    replayState.timer = setInterval(() => {
        if (!replayState) return;
        if (replayState.index >= replayState.frames.length - 1) {
            clearInterval(replayState.timer);
            replayState.timer = null;
            replayState.playButton.textContent = "Play";
            return;
        }

        replayState.index += 1;
        renderReplayFrame(replayState.index);
    }, 280);
}

function renderReplayFrame(index) {
    if (!replayState) return;
    replayState.index = Math.max(0, Math.min(index, replayState.frames.length - 1));

    const frame = replayState.frames[replayState.index];
    replayState.slider.value = String(replayState.index);
    replayState.timeLabel.textContent = formatReplayTime(frame.timestamp);
    replayState.lapLabel.textContent = frame.leaderLap ? `Leader Lap ${frame.leaderLap}` : "Leader Lap —";

    replayState.tableBody.innerHTML = "";
    frame.standings.forEach(entry => {
        const driver = replayState.driverMap[entry.driverNumber] || {};
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td class="mono-cell replay-pos">${entry.position}</td>
          <td>
            <div class="driver-cell replay-driver-cell">
              <div class="team-stripe" style="background:${teamColor(driver.team_name)}"></div>
              <div>
                <div class="driver-code">${driver.name_acronym || `#${entry.driverNumber}`}</div>
                <div class="driver-full">${driver.full_name || ""}</div>
              </div>
            </div>
          </td>
          <td class="mono-cell">${entry.lapNumber ?? "—"}</td>
          <td class="mono-cell">${formatGapValue(entry.gap, entry.position)}</td>
        `;
        replayState.tableBody.appendChild(tr);
    });
}

function initReplayPanel(drivers, positions, laps, intervals) {
    const panel = document.getElementById("replay-panel");
    const driverMap = {};
    drivers.forEach(d => {
        driverMap[d.driver_number] = d;
    });

    const frames = buildReplayFrames(positions, laps, intervals);
    if (frames.length < 2) {
        panel.classList.add("hidden");
        return;
    }

    panel.classList.remove("hidden");
    panel.innerHTML = `
      <div class="replay-header">
        <div>
          <div class="replay-title">Session Replay</div>
          <div class="replay-sub">Use the slider to inspect position, lap, and gap progression.</div>
        </div>
        <div class="replay-meta">
          <span id="replay-time">—</span>
          <span id="replay-lap">Leader Lap —</span>
        </div>
      </div>
      <div class="replay-controls">
        <button id="replay-play-btn" type="button">Play</button>
        <input id="replay-slider" type="range" min="0" max="${frames.length - 1}" value="${frames.length - 1}" step="1" />
      </div>
      <div class="replay-table-wrap">
        <table class="standings-table replay-table">
          <thead>
            <tr>
              <th>POS</th>
              <th>DRIVER</th>
              <th>LAP</th>
              <th>GAP</th>
            </tr>
          </thead>
          <tbody id="replay-body"></tbody>
        </table>
      </div>
    `;

    const playButton = document.getElementById("replay-play-btn");
    const slider = document.getElementById("replay-slider");
    const timeLabel = document.getElementById("replay-time");
    const lapLabel = document.getElementById("replay-lap");
    const tableBody = document.getElementById("replay-body");

    replayState = {
        frames,
        driverMap,
        playButton,
        slider,
        timeLabel,
        lapLabel,
        tableBody,
        timer: null,
        index: frames.length - 1,
    };

    playButton.addEventListener("click", toggleReplayPlayback);
    slider.addEventListener("input", e => {
        if (!replayState) return;
        if (replayState.timer) {
            clearInterval(replayState.timer);
            replayState.timer = null;
            replayState.playButton.textContent = "Play";
        }
        renderReplayFrame(Number(e.target.value));
    });

    renderReplayFrame(frames.length - 1);
}

function showStatus(msg, type = "loading") {
    const el = document.getElementById("status");
    el.className = `status ${type}`;
    el.innerHTML = type === "loading"
        ? `<div class="spinner"></div><span>${msg}</span>`
        : `<span>⚠ ${msg}</span>`;
    el.classList.remove("hidden");
}

function hideStatus() {
    document.getElementById("status").classList.add("hidden");
}

document.addEventListener("DOMContentLoaded", () => loadStandings());


function formatLapTime(seconds) {
    if (!seconds || seconds <= 0) return "—";
    const mins = Math.floor(seconds / 60);
    const secs = (seconds % 60).toFixed(3).padStart(6, "0");
    return `${mins}:${secs}`;
}

function formatDelta(seconds) {
    if (!seconds || seconds <= 0) return "—";
    return `+${seconds.toFixed(3)}s`;
}

function isTimedLap(lap) {
    if (!lap) return false;
    if (lap.is_pit_out_lap) return false;
    if (!(lap.lap_duration > 50 && lap.lap_duration < 150)) return false;
    if (!(lap.duration_sector_1 > 10 && lap.duration_sector_2 > 10 && lap.duration_sector_3 > 10)) return false;
    return true;
}

function lapStats(laps) {
    const valid = laps.filter(isTimedLap);

    if (!valid.length) {
        return {
            valid,
            best: null,
            sector1Best: null,
            sector2Best: null,
            sector3Best: null,
        };
    }

    const durations = valid.map(l => l.lap_duration);
    const best = Math.min(...durations);
    const sector1Best = Math.min(...valid.map(l => l.duration_sector_1));
    const sector2Best = Math.min(...valid.map(l => l.duration_sector_2));
    const sector3Best = Math.min(...valid.map(l => l.duration_sector_3));

    return { valid, best, sector1Best, sector2Best, sector3Best };
}

function renderLapTimes(laps, driverMap) {
    if (!laps.length) {
        renderInlineNotice("No lap data available for this session.");
        return;
    }

    const validLaps = laps.filter(isTimedLap);
    const fastestTime = validLaps.length ? Math.min(...validLaps.map(l => l.lap_duration)) : null;

    const lapsByDriver = laps.reduce((acc, lap) => {
        if (!acc[lap.driver_number]) acc[lap.driver_number] = [];
        acc[lap.driver_number].push(lap);
        return acc;
    }, {});

    lapUiState = {
        lapsByDriver,
        fastestTime,
        sessionStats: lapStats(validLaps),
        driverMap,
    };

    renderInlineNotice("Click a driver row to expand lap details.");
}


function collapseLapExpansion() {
    const expandedRow = document.querySelector(".lap-expand-row");
    if (expandedRow) expandedRow.remove();

    const rows = document.querySelectorAll(".driver-row");
    rows.forEach(row => row.classList.remove("active"));

    selectedDriverNumber = null;
}


function setSelectedDriver(driverNumber) {
    if (!lapUiState || !lapUiState.lapsByDriver[driverNumber]) return;

    selectedDriverNumber = Number(driverNumber);
    collapseLapExpansion();
    selectedDriverNumber = Number(driverNumber);

    const selectedRow = document.querySelector(`.driver-row[data-driver-number="${driverNumber}"]`);
    if (!selectedRow) return;
    selectedRow.classList.add("active");

    const expandedRow = document.createElement("tr");
    expandedRow.className = "lap-expand-row";
    expandedRow.innerHTML = `
      <td colspan="4">
        <div class="lap-expand-panel">
          <div class="lap-metrics"></div>
          <div class="lap-table-wrap"></div>
        </div>
      </td>
    `;
    selectedRow.insertAdjacentElement("afterend", expandedRow);

    const metrics = expandedRow.querySelector(".lap-metrics");
    const tableWrap = expandedRow.querySelector(".lap-table-wrap");
    const laps = lapUiState.lapsByDriver[driverNumber];

    updateLapOverview(
        metrics,
        tableWrap,
        laps,
        lapUiState.fastestTime,
        lapUiState.sessionStats,
        lapUiState.driverMap[driverNumber]
    );
}


function updateLapOverview(metricsContainer, tableContainer, laps, fastestTime, sessionStats, driver) {
        const stats = lapStats(laps || []);
        const sessionBest = sessionStats?.best ?? null;
        const deltaToSessionBest = stats.best && sessionBest ? stats.best - sessionBest : null;

        metricsContainer.innerHTML = `
            <div class="metric-card">
                <div class="metric-label">Selected Driver</div>
                <div class="metric-value">${driver?.name_acronym || `#${selectedDriverNumber || "—"}`}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Best Timed Lap</div>
                <div class="metric-value">${formatLapTime(stats.best)}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Timed Laps</div>
                <div class="metric-value">${stats.valid.length}</div>
            </div>
            <div class="metric-card">
                <div class="metric-label">Gap To Session Best</div>
                <div class="metric-value">${deltaToSessionBest !== null && deltaToSessionBest > 0 ? formatDelta(deltaToSessionBest) : "—"}</div>
            </div>
        `;

        renderLapTable(tableContainer, laps, fastestTime, stats.best, sessionStats, stats);
}


    function renderLapTable(container, laps, fastestTime, selectedDriverBest, sessionStats, driverStats) {
    if (!laps || !laps.length) {
        container.innerHTML = `<div class="empty-msg">No lap data.</div>`;
        return;
    }

    // Sort by lap number
    laps.sort((a, b) => a.lap_number - b.lap_number);

    const table = document.createElement("table");
    table.className = "standings-table";
    table.innerHTML = `
        <thead>
        <tr>
            <th>LAP</th>
            <th style="text-align:right">TIME</th>
            <th style="text-align:right">DELTA</th>
            <th style="text-align:right">S1</th>
            <th style="text-align:right">S2</th>
            <th style="text-align:right">S3</th>
            <th>NOTE</th>
        </tr>
        </thead>
    `;

    const tbody = document.createElement("tbody");

    laps.forEach(lap => {
                const isFastest = fastestTime !== null && lap.lap_duration === fastestTime;
                const isDriverBest = selectedDriverBest !== null && lap.lap_duration === selectedDriverBest;
        const isPitOut = lap.is_pit_out_lap;
                const delta = lap.lap_duration > 0 && selectedDriverBest ? lap.lap_duration - selectedDriverBest : null;
            const isSector1SessionBest = sessionStats?.sector1Best !== null && lap.duration_sector_1 === sessionStats?.sector1Best;
            const isSector2SessionBest = sessionStats?.sector2Best !== null && lap.duration_sector_2 === sessionStats?.sector2Best;
            const isSector3SessionBest = sessionStats?.sector3Best !== null && lap.duration_sector_3 === sessionStats?.sector3Best;
            const isSector1DriverBest = driverStats?.sector1Best !== null && lap.duration_sector_1 === driverStats?.sector1Best;
            const isSector2DriverBest = driverStats?.sector2Best !== null && lap.duration_sector_2 === driverStats?.sector2Best;
            const isSector3DriverBest = driverStats?.sector3Best !== null && lap.duration_sector_3 === driverStats?.sector3Best;

        const row = document.createElement("tr");
        row.innerHTML = `
      <td class="mono-cell" style="text-align:left">${lap.lap_number}</td>
            <td class="mono-cell ${isFastest ? "fastest" : ""} ${isDriverBest ? "personal-best" : ""}">${formatLapTime(lap.lap_duration)}</td>
            <td class="mono-cell">${delta !== null && delta > 0 ? formatDelta(delta) : "—"}</td>
        <td class="mono-cell ${isSector1SessionBest ? "fastest" : isSector1DriverBest ? "personal-best" : ""}">${formatLapTime(lap.duration_sector_1)}</td>
        <td class="mono-cell ${isSector2SessionBest ? "fastest" : isSector2DriverBest ? "personal-best" : ""}">${formatLapTime(lap.duration_sector_2)}</td>
        <td class="mono-cell ${isSector3SessionBest ? "fastest" : isSector3DriverBest ? "personal-best" : ""}">${formatLapTime(lap.duration_sector_3)}</td>
      <td class="mono-cell ${isPitOut ? "pit-lap" : ""}">
                ${isFastest ? "◆ SESSION BEST" : isDriverBest ? "● PERSONAL BEST" : isPitOut ? "PIT OUT" : ""}
      </td>
    `;

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
}