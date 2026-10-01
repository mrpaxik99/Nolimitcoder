NolimitCoder — Logs
===================

Sem se ukládají všechny chyby a diagnostika aplikace ( denní textové soubory ).

  errors-2026-10-01.txt   Error Log — každá chyba aplikace (AI stream, selhaný
                          nástroj, výjimka v UI, hlavní proces). Tajemství
                          (tokeny, hesla) se před zápisem mažou.
  ai-debug.log            Diagnostika agenta — každé kolo, každé volání nástroje,
                          každý požadavek na AI. Rotace na 8 MB (.old).

Soubory se mažou po 30 dnech, Error Log se navíc točí na 5 MB.
Složku určuje app (errlog.js), v pořadí:
  1) config.json → logsDir   (na tomto stroji je to tato složka v repozitáři)
  2) <repo>/NolimitCoder/Logs (dev build spuštěný z repozitáře)
  3) %APPDATA%\NolimitCoder V2\logs (instalace u zákazníka — výchozí)

Obsah složky se necommituje (viz .gitignore) — slouží jen k místnímu čtení.
