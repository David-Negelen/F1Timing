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
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
}

async function loadStandings() {
    showStatus("Fetching session data…");

    try {
        const [drivers, positions, laps] = await Promise.all([
            apiFetch("/api/drivers", { session_key: SESSION_KEY }),
            apiFetch("/api/positions", { session_key: SESSION_KEY }),
            apiFetch("/api/laps", { session_key: SESSION_KEY }),
        ]);

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
        renderLapTimes(laps, driverMap);

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

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
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

function renderLapTimes(laps, driverMap) {
    const wrap = document.getElementById("standings-wrap");
    const validLaps = laps.filter(l => l.lap_duration > 0 && !l.is_pit_out_lap);
    const fastestTime = Math.min(...validLaps.map(l => l.lap_duration));
    const lapsByDriver = laps.reduce((acc, lap) => {
        if (!acc[lap.driver_number]) acc[lap.driver_number] = [];
        acc[lap.driver_number].push(lap);
        return acc;
    }, {});

    const title = document.createElement("div");
    title.className = "section-title";
    title.textContent = "Lap Times";
    wrap.appendChild(title);

    const controls = document.createElement("div");
    controls.className = "lap-controls";

    const driverNumbers = Object.keys(lapsByDriver);

    const sel = document.createElement("select");
    sel.id = "lap-driver-select";
    driverNumbers.forEach(num => {
        const d = driverMap[num] || {};
        const opt = document.createElement("option");
        opt.value = num;
        opt.textContent = d.full_name || `Driver #${num}`;
        sel.appendChild(opt);
    });
    controls.appendChild(sel);
    wrap.appendChild(controls);

    const tableWrap = document.createElement("div");
    tableWrap.id = "lap-table-wrap";
    wrap.appendChild(tableWrap);

    renderLapTable(tableWrap, lapsByDriver[driverNumbers[0]], fastestTime);

    sel.addEventListener("change", () => {
        renderLapTable(tableWrap, lapsByDriver[sel.value], fastestTime);
    });
}


function renderLapTable(container, laps, fastestTime) {
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
            <th style="text-align:right">S1</th>
            <th style="text-align:right">S2</th>
            <th style="text-align:right">S3</th>
            <th>NOTE</th>
        </tr>
        </thead>
    `;

    const tbody = document.createElement("tbody");

    laps.forEach(lap => {
        const isFastest = lap.lap_duration === fastestTime;
        const isPitOut = lap.is_pit_out_lap;

        const row = document.createElement("tr");
        row.innerHTML = `
      <td class="mono-cell" style="text-align:left">${lap.lap_number}</td>
      <td class="mono-cell ${isFastest ? "fastest" : ""}">${formatLapTime(lap.lap_duration)}</td>
      <td class="mono-cell">${formatLapTime(lap.duration_sector_1)}</td>
      <td class="mono-cell">${formatLapTime(lap.duration_sector_2)}</td>
      <td class="mono-cell">${formatLapTime(lap.duration_sector_3)}</td>
      <td class="mono-cell ${isPitOut ? "pit-lap" : ""}">
        ${isFastest ? "◆ FASTEST" : isPitOut ? "PIT OUT" : ""}
      </td>
    `;

        tbody.appendChild(row);
    });

    table.appendChild(tbody);
    container.innerHTML = "";
    container.appendChild(table);
}