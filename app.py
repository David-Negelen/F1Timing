from flask import Flask, jsonify, render_template, request
import requests
import time

app = Flask(__name__)

OPENF1_BASE = "https://api.openf1.org/v1"
DEFAULT_CACHE_TTL = 60
MAX_RETRIES = 3


class OpenF1APIError(Exception):
    def __init__(self, message, status_code=502, retry_after=None):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.retry_after = retry_after


_cache = {}


def openf1_get(path, params=None):
    """Call OpenF1 with retries and return parsed JSON."""
    cleaned_params = {k: v for k, v in (params or {}).items() if v is not None}
    last_error = None

    for attempt in range(MAX_RETRIES):
        response = None
        try:
            response = requests.get(
                f"{OPENF1_BASE}{path}",
                params=cleaned_params,
                timeout=15,
            )

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                try:
                    wait_seconds = int(retry_after) if retry_after else 1
                except ValueError:
                    wait_seconds = 1

                if attempt < MAX_RETRIES - 1:
                    time.sleep(max(wait_seconds, 1))
                    continue

                raise OpenF1APIError(
                    "OpenF1 rate limit reached. Please try again shortly.",
                    status_code=429,
                    retry_after=retry_after,
                )

            if 500 <= response.status_code < 600 and attempt < MAX_RETRIES - 1:
                time.sleep(0.5 * (attempt + 1))
                continue

            response.raise_for_status()
            return response.json()

        except requests.RequestException as err:
            last_error = err
            if attempt < MAX_RETRIES - 1:
                time.sleep(0.5 * (attempt + 1))
                continue

            status_code = response.status_code if response is not None else 502
            raise OpenF1APIError(
                f"OpenF1 request failed: {err}",
                status_code=status_code,
            ) from err

    raise OpenF1APIError(f"OpenF1 request failed: {last_error}")


def openf1_get_cached(path, params=None, ttl=DEFAULT_CACHE_TTL, allow_stale_on_error=True):
    key = (path, tuple(sorted((params or {}).items())))
    now = time.time()
    cached = _cache.get(key)

    if cached and now - cached["ts"] <= ttl:
        return cached["data"]

    try:
        data = openf1_get(path, params)
        _cache[key] = {"data": data, "ts": now}
        return data
    except OpenF1APIError:
        if allow_stale_on_error and cached:
            return cached["data"]
        raise


@app.errorhandler(OpenF1APIError)
def handle_openf1_error(err):
    payload = {"error": err.message}
    if err.retry_after is not None:
        payload["retry_after"] = err.retry_after
    return jsonify(payload), err.status_code


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/meetings")
def meetings():
    year = request.args.get("year", type=int)
    data = openf1_get_cached("/meetings", {"year": year}, ttl=600)

    data.sort(key=lambda m: m.get("date_start") or "")
    return jsonify(data)


@app.route("/api/sessions")
def sessions():
    meeting_key = request.args.get("meeting_key", type=int)
    data = openf1_get_cached("/sessions", {"meeting_key": meeting_key}, ttl=180)
    return jsonify(data)


@app.route("/api/session_info")
def session_info():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/sessions", {"session_key": session_key}, ttl=180)
    return jsonify(data[0] if data else {})


@app.route("/session/<int:session_key>")
def session_page(session_key):
    return render_template("session.html", session_key=session_key)

@app.route("/api/drivers")
def drivers():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/drivers", {"session_key": session_key}, ttl=120)
    return jsonify(data)


@app.route("/api/positions")
def positions():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/position", {"session_key": session_key}, ttl=30)
    return jsonify(data)

@app.route("/api/laps")
def laps():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/laps", {"session_key": session_key}, ttl=45)
    return jsonify(data)


@app.route("/api/intervals")
def intervals():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/intervals", {"session_key": session_key}, ttl=20)
    return jsonify(data)


@app.route("/api/location")
def location():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/location", {"session_key": session_key}, ttl=15)
    return jsonify(data)


@app.route("/api/stints")
def stints():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/stints", {"session_key": session_key}, ttl=45)
    return jsonify(data)


@app.route("/api/race_control")
def race_control():
    session_key = request.args.get("session_key", type=int)
    data = openf1_get_cached("/race_control", {"session_key": session_key}, ttl=20)
    return jsonify(data)


if __name__ == "__main__":
    app.run(debug=True, port=5000)