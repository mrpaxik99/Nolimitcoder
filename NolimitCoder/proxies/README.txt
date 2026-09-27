Proxy pool — ProxyScrape free list (https://proxyscrape.com)
==============================================================
Source: v4 public API (no key), downloads automatically from the app.
Files:
  http.txt    — HTTP proxies as ip:port (used for the opencode gateway)
  socks4.txt  — SOCKS4 proxies as ip:port
  socks5.txt  — SOCKS5 proxies as ip:port
  all.txt     — everything with prefix (http://, socks4://, socks5://)
  proxies.json— counts + download date

How it works in the app (src/main/proxy.js + main.js):
  1. Generation runs normally DIRECT (fastest).
  2. The opencode gateway returns 429 / quota / FreeUsageLimit / Retry-After
     → the app immediately treats it as "approaching the limit / quota".
  3. Within milliseconds it switches to a RANDOM proxy from this pool
     (HTTP preferred, then SOCKS5, then SOCKS4) and retries the request
     via a proxy tunnel (CONNECT + TLS). A dead proxy is marked and
     is not reused within the same attempt. Up to 5 different proxies are tried in a row.
  4. When there was a fresh 429 in the last few minutes, the next request
     goes straight via proxy (preemptive switch, doesn't wait for another 429).
  5. After the quota fades (10 min without a hit) it goes direct again.
  6. When all 5 proxies fail too, a second NolimitCoder model is tried
     (it has its own quota) — only then is an honest exhaustion message shown.

Refresh: on startup + every 30 min + by clicking the badge in the topbar.
Manual refresh: https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all
NOTE: free proxies are public and slow — they serve only as an emergency fallback for quota, not for everyday use.
