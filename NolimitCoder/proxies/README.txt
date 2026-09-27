Proxy pool — ProxyScrape free list (https://proxyscrape.com)
==============================================================
Zdroj: v4 public API (bez klíče), stahuje se samo z aplikace.
Soubory:
  http.txt    — HTTP proxy ve tvaru ip:port (používají se pro bránu opencode)
  socks4.txt  — SOCKS4 proxy ve tvaru ip:port
  socks5.txt  — SOCKS5 proxy ve tvaru ip:port
  all.txt     — vše s prefixem (http://, socks4://, socks5://)
  proxies.json— počty + datum stažení

Jak to funguje v aplikaci (src/main/proxy.js + main.js):
  1. Generování jede normálně NAPŘÍMO (nejrychlejší).
  2. Brána opencode vrátí 429 / quota / FreeUsageLimit / Retry-After
     → aplikace to hned vyhodnotí jako "blížím se limitu / quota".
  3. Během milisekund se přepne na RANDOM proxy z tohoto poolu
     (přednostně HTTP, pak SOCKS5, pak SOCKS4) a požadavek se zopakuje
     přes proxy tunel (CONNECT + TLS). Padlá proxy se označí a už se
     v daném pokusu nepoužije. Zkouší se až 5 různých proxy za sebou.
  4. Když byla čerstvá 429 v posledních minutách, jede další požadavek
     rovnou přes proxy (preemptivní přepnutí, nečeká se na další 429).
  5. Po odeznění quota (10 min bez zásahu) se jede zase napřímo.
  6. Když padne i všech 5 proxy, zkusí se ještě druhý model NolimitCoder
     (má vlastní kvótu) — až pak se ukáže poctivá hláška o vyčerpání.

Obnovení: po startu + každých 30 min + klikem na badge v topbaru.
Ruční refresh: https://api.proxyscrape.com/v4/free-proxy-list/get?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all
POZOR: free proxy jsou veřejné a pomalé — slouží jen jako nouzovka při quota, ne na běžné ježdění.
