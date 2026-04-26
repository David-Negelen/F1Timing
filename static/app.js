async function apiFetch(path, params = {}) {
    const url = new URL(path, window.location.origin);

    Object.entries(params).forEach(([key, value]) => {
        if (value !== null && value !== undefined) {
            url.searchParams.set(key, value);
        }
    });

    const response = await fetch(url);

    if (!response.ok) {
        let payload = null;
        try {
            payload = await response.json();
        } catch (_) {
            payload = null;
        }

        const retryAfter = payload?.retry_after;
        const apiError = payload?.error;
        const baseMessage = apiError || `Request failed with ${response.status}`;
        const hint = response.status === 429
            ? ` Rate limit reached${retryAfter ? `, retry in ${retryAfter}s.` : "."}`
            : "";

        throw new Error(`${baseMessage}${hint}`);
    }

    return response.json();
}


const COUNTRY_FLAGS = {
    "Bahrain": "🇧🇭",
    "Saudi Arabia": "🇸🇦",
    "Australia": "🇦🇺",
    "Japan": "🇯🇵",
    "China": "🇨🇳",
    "United States": "🇺🇸",
    "Italy": "🇮🇹",
    "Monaco": "🇲🇨",
    "Canada": "🇨🇦",
    "Spain": "🇪🇸",
    "Austria": "🇦🇹",
    "United Kingdom": "🇬🇧",
    "Hungary": "🇭🇺",
    "Belgium": "🇧🇪",
    "Netherlands": "🇳🇱",
    "Singapore": "🇸🇬",
    "Azerbaijan": "🇦🇿",
    "Mexico": "🇲🇽",
    "Brazil": "🇧🇷",
    "UAE": "🇦🇪",
    "Abu Dhabi": "🇦🇪",
    "Qatar": "🇶🇦",
    "Las Vegas": "🇺🇸",
    "Miami": "🇺🇸",
};

function getFlag(countryName) {
    if (!countryName) return "🏁";

    if (COUNTRY_FLAGS[countryName]) return COUNTRY_FLAGS[countryName];
    const key = Object.keys(COUNTRY_FLAGS).find(k =>
        countryName.toLowerCase().includes(k.toLowerCase())
    );
    return key ? COUNTRY_FLAGS[key] : "🏁";
}


function formatDate(dateStr) {
    if (!dateStr) return "—";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
    });
}

function formatSessionDate(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-GB", {
        weekday: "short",
        day: "numeric",
        month: "short",
    }) + " · " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " UTC";
}

function isFutureMeeting(meeting) {
    if (!meeting?.date_start) return false;
    return new Date(meeting.date_start) > new Date();
}

function isCancelledMeeting(meeting) {
    const status = `${meeting?.status || ""} ${meeting?.meeting_status || ""}`.toLowerCase();
    const names = `${meeting?.meeting_name || ""} ${meeting?.meeting_official_name || ""}`.toLowerCase();
    const explicitFlag = meeting?.cancelled === true || meeting?.canceled === true || meeting?.is_cancelled === true;

    return explicitFlag || status.includes("cancel") || names.includes("cancelled") || names.includes("canceled");
}

function getSessionStatus(session) {
    const now = new Date();
    const start = session.date_start ? new Date(session.date_start) : null;
    const end = session.date_end ? new Date(session.date_end) : null;

    if (start && start > now) return "upcoming";
    if (start && end && start <= now && end >= now) return "live";
    return "completed";
}


function showStatus(message, type = "loading") {
    const el = document.getElementById("status");
    el.className = `status ${type}`;
    el.innerHTML =
        type === "loading"
            ? `<div class="spinner"></div><span>${message}</span>`
            : `<span>${message}</span>`;
    el.classList.remove("hidden");
}

function hideStatus() {
    document.getElementById("status").classList.add("hidden");
}


async function loadRaces() {
    const year = document.getElementById("year-select").value;
    const btn = document.getElementById("load-btn");
    const grid = document.getElementById("race-grid");

    btn.disabled = true;
    btn.textContent = "Loading…";
    grid.innerHTML = "";
    document.getElementById("summary").classList.add("hidden");
    showStatus(`Fetching ${year} season…`);

    try {
        const meetings = await apiFetch("/api/meetings", { year });

        hideStatus();

        if (!meetings.length) {
            grid.innerHTML = `
        <div class="empty-state">
          <div style="font-size:40px">🏁</div>
          <p>No races found for ${year}.</p>
        </div>`;
            return;
        }

        const countries = new Set(meetings.map(m => m.country_name).filter(Boolean));
        const circuits = new Set(meetings.map(m => m.circuit_short_name).filter(Boolean));

        document.getElementById("sum-races").textContent = meetings.length;
        document.getElementById("sum-countries").textContent = countries.size;
        document.getElementById("sum-circuits").textContent = circuits.size;
        document.getElementById("summary").classList.remove("hidden");

        meetings.forEach((meeting, index) => {
            const card = buildRaceCard(meeting, index + 1);
            grid.appendChild(card);
        });

    } catch (err) {
        showStatus(`Failed to load races: ${err.message}`, "error");
    } finally {
        btn.disabled = false;
        btn.textContent = "Load";
    }
}


function buildRaceCard(meeting, roundNumber) {
    const flag = getFlag(meeting.country_name);
    const date = formatDate(meeting.date_start);
    const isFuture = isFutureMeeting(meeting);
    const isCancelled = isCancelledMeeting(meeting);

    const card = document.createElement("div");
    card.className = `race-card ${isFuture ? "future" : ""} ${isCancelled ? "cancelled" : ""}`.trim();
    card.setAttribute("aria-label", `Round ${roundNumber}: ${meeting.meeting_name}`);

    card.innerHTML = `
        <div class="card-accent"></div>
        <div class="card-body">
        <div class="card-top">
            <span class="round-badge">RND ${String(roundNumber).padStart(2, "0")}</span>
            <span class="card-flag">${flag}</span>
        </div>
        <div class="card-name">${meeting.meeting_name || "—"}</div>
        <div class="card-circuit">${meeting.circuit_short_name || ""}</div>
        <div class="card-footer">
            <span class="card-date">${date}</span>
            <span class="card-country">${meeting.country_name || ""}</span>
        </div>
        ${isCancelled ? '<div class="card-status cancelled">Cancelled</div>' : isFuture ? '<div class="card-status upcoming">Upcoming</div>' : ""}
        </div>
    `;

    card.addEventListener("click", () => openDrawer(meeting, roundNumber));

    return card;
}

function openDrawer(meeting, roundNumber) {
    document.getElementById("drawer-round").textContent = `ROUND ${String(roundNumber).padStart(2, "0")} · ${meeting.year || ""}`;
    document.getElementById("drawer-title").textContent = meeting.meeting_name || "—";
    document.getElementById("drawer-sub").textContent = [meeting.circuit_short_name, meeting.country_name].filter(Boolean).join(" · ");
    document.getElementById("drawer").classList.remove("hidden");
    document.getElementById("drawer-overlay").classList.remove("hidden");

    if (isCancelledMeeting(meeting)) {
        document.getElementById("drawer-sessions").innerHTML = `
            <div class="drawer-loading" style="color:#ff8f8f">This race weekend is marked as cancelled.</div>
        `;
        return;
    }

    loadDrawerSessions(meeting.meeting_key);
}

function closeDrawer() {
    document.getElementById("drawer").classList.add("hidden");
    document.getElementById("drawer-overlay").classList.add("hidden");
}

document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
});


async function loadDrawerSessions(meetingKey) {
    const container = document.getElementById("drawer-sessions");
    container.innerHTML = `<div class="drawer-loading">Loading sessions…</div>`;

    try {
        const sessions = await apiFetch("/api/sessions", { meeting_key: meetingKey });

        if (!sessions.length) {
            container.innerHTML = `<div class="drawer-loading">No sessions found.</div>`;
            return;
        }

        sessions.sort((a, b) => (a.date_start || "").localeCompare(b.date_start || ""));

        container.innerHTML = `<div class="session-section-title">Weekend Sessions</div>`;

        sessions.forEach(session => {
            const row = document.createElement("div");
            const status = getSessionStatus(session);
            const isFuture = status === "upcoming";
            const typeClass = getSessionTypeClass(session.session_type);
            row.className = `session-row ${isFuture ? "disabled" : ""}`;

            const statusLabel = status === "upcoming"
                ? "UPCOMING"
                : status === "live"
                    ? "LIVE"
                    : session.session_type || "—";

            const statusClass = status === "live" ? "live" : isFuture ? "upcoming" : typeClass;
            const helperText = isFuture
                ? "Opens when the session starts"
                : status === "live"
                    ? "Session currently running"
                    : "Open lap and standings overview";

            row.innerHTML = `
                <div>
                <div class="session-name">${session.session_name || session.session_type}</div>
                <div class="session-date">${formatSessionDate(session.date_start)}</div>
                <div class="session-help">${helperText}</div>
                </div>
                <span class="session-type-badge ${statusClass}">
                ${statusLabel}
                </span>
            `;


            if (!isFuture) {
                row.style.cursor = "pointer";
                row.addEventListener("click", () => {
                window.location.href = `/session/${session.session_key}`;
                });
            }

            container.appendChild(row);
        });

    } catch (err) {
        container.innerHTML = `<div class="drawer-loading" style="color:#ff6b6b">Error: ${err.message}</div>`;
    }
}

function getSessionTypeClass(type) {
    if (!type) return "";
    const t = type.toLowerCase();
    if (t.includes("race") && !t.includes("sprint")) return "race";
    if (t.includes("qualifying") || t.includes("quali")) return "quali";
    if (t.includes("sprint")) return "sprint";
    return "";
}


document.addEventListener("DOMContentLoaded", () => loadRaces());