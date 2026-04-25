from flask import Flask, jsonify, render_template, request
import requests

app = Flask(__name__)

OPENF1_BASE = "https://api.openf1.org/v1"


def openf1_get(path, params=None):
    """Call OpenF1 and return parsed JSON, or raise on error."""
    response = requests.get(
        f"{OPENF1_BASE}{path}",
        params={k: v for k, v in (params or {}).items() if v is not None},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meetings")
def meetings():
    year = request.args.get("year", type=int)
    data = openf1_get("/meetings", {"year": year})

    data.sort(key=lambda m: m.get("date_start") or "")
    return jsonify(data)


@app.route("/api/sessions")
def sessions():
    meeting_key = request.args.get("meeting_key", type=int)
    data = openf1_get("/sessions", {"meeting_key": meeting_key})
    return jsonify(data)


@app.route("/session/<int:session_key>")
def session_page(session_key):
    return render_template("session.html", session_key=session_key)

@app.route("/api/drivers")
def drivers():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get("/drivers", {"session_key": session_key})
    return jsonify(data)


@app.route("/api/positions")
def positions():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get("/position", {"session_key": session_key})
    return jsonify(data)

@app.route("/api/laps")
def laps():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/laps", {"session_key": session_key})
    return jsonify(data)


_cache = {}

def openf1_get_cached(path, params=None):
    key = (path, tuple(sorted((params or {}).items())))
    if key not in _cache:
        _cache[key] = openf1_get(path, params)
    return _cache[key]


if __name__ == "__main__":
    app.run(debug=True, port=5000)