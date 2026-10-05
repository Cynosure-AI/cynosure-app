# Backups

- **Tool:** restic
- **Ziel:** Hetzner Storage Box BX11 (1 TB), Standort Falkenstein
- **Zeitplan:** jede Nacht um 02:00 per systemd-Timer auf dem Pi
- **Aufbewahrung:** 7 tägliche, 4 wöchentliche, 12 monatliche Snapshots
- **Gesichert:** Vaultwarden-Daten, Home-Assistant-Konfiguration, ~/Projekte vom Laptop (per Syncthing auf den Pi)

## Test
Letzter Restore-Test am 14. Juni 2026: erfolgreich, Vaultwarden in 6 Minuten wiederhergestellt.
