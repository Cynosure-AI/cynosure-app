# Projekt: Steirerwerk Shop-Relaunch

## Eckdaten
| | |
|-|-|
| **Kunde** | Steirerwerk GmbH, Kapfenberg |
| **Ansprechpartner** | Markus Hofer (Head of E-Commerce) |
| **Design** | Sophie Lindner (UX-Lead Steirerwerk) |
| **Stack** | Shopify Hydrogen, Sanity CMS, Vercel |
| **Budget** | 18.400 € (gedeckelt, 216 Stunden) |
| **Go-Live** | 15. November 2026 |
| **Start** | 4. Mai 2026 |

## Scope
- Neuer Headless-Storefront mit Hydrogen
- Produktdaten aus dem bestehenden Shopify-Backend, Ratgeber-Inhalte aus Sanity
- Händlersuche mit Karte (Mapbox)
- Mehrsprachig: Deutsch, Englisch, Slowenisch

## Offene Punkte
- Klarna-Integration: Renate Pölzl muss noch freigeben
- Performance-Budget: LCP unter 2,0 Sekunden auf 4G
- Slowenische Übersetzungen kommen von einer Agentur in Maribor

## Abrechnung
Abrechnung monatlich nach Aufwand, maximal bis zum Budgetdeckel. Rechnungen gehen an buchhaltung@steirerwerk.example mit Bestellnummer PO-2026-0418.

## Meeting-Notizen

### 18.05.2026 – Kick-off vor Ort
Erstes Treffen in der Firmenzentrale. Anwesend waren der Head of E-Commerce, die UX-Lead und zwei Leute aus dem Kundenservice. Wichtigste Erkenntnis: Die meisten Retouren kommen wegen falscher Größenangaben bei den Wanderschuhen. Ein Größenberater soll deshalb in Phase 2 kommen. Die bestehende Seite lädt auf dem Handy über sechs Sekunden, das war der Hauptgrund für den Relaunch. Wir haben vereinbart, dass ich jeden Freitag einen kurzen Loom-Clip mit dem Fortschritt schicke statt eines schriftlichen Berichts.

### 12.06.2026 – Design-Review Startseite
Die Startseite wurde zweimal überarbeitet. Der Hero soll statt eines Karussells ein einzelnes Video ohne Ton zeigen, maximal 2 MB groß. Die Kategorienavigation bekommt Piktogramme. Beim Kontrast der Preisangaben gab es Nachbesserungsbedarf, Grau auf Weiß war zu schwach. Freigabe der Startseite erfolgte am selben Tag.

### 12.08.2026 – Versand und Zahlung
Entscheidung: **Versandkostenfrei ab 79 € Bestellwert**, darunter 4,90 € nach Österreich und 8,90 € nach Deutschland und Slowenien. Zahlungsarten zum Start: Kreditkarte, PayPal, Apple Pay, EPS und später Klarna. Der Kunde will keine Nachnahme mehr anbieten, weil die Rücklaufquote zu hoch war.

### 09.09.2026 – Performance
Lighthouse mobil auf der Staging-Umgebung: Startseite 91, Produktseite 84. Die Produktseite verliert vor allem durch die Bildergalerie. Plan: Bilder als AVIF ausliefern und die Galerie erst nach Interaktion laden. Staging läuft unter staging-shop.steirerwerk.example, Zugang per Basic Auth (Zugangsdaten im Bitwarden-Ordner "Kunden").

### 23.09.2026 – Inhalte
Die Ratgeberartikel werden aus dem alten Blog übernommen, insgesamt 64 Artikel. Davon werden 18 gestrichen, weil die Produkte nicht mehr verkauft werden. Für die Umleitungen erstelle ich eine Redirect-Tabelle mit allen alten URLs. Die Übersetzungen ins Slowenische verzögern sich um zwei Wochen.

### 30.09.2026 – Risiken vor dem Go-Live
Drei Risiken haben wir festgehalten. Erstens die verspäteten Übersetzungen: Falls sie nicht bis Ende Oktober da sind, geht die slowenische Version erst im Dezember online, Deutsch und Englisch starten trotzdem planmäßig. Zweitens die Lagerbestände: Der Warenwirtschafts-Export läuft nur alle 30 Minuten, bei Aktionen kann es zu Überverkäufen kommen. Lösung: ein Puffer von drei Stück pro Artikel, der im Shop nicht angezeigt wird. Drittens meine Abwesenheit in Leoben um den Go-Live herum. Vereinbart ist, dass ich in dieser Woche nur remote erreichbar bin und der Kunde einen Notfallkontakt bei der Agentur seines Hostings hat.

Für den Go-Live-Tag selbst gibt es eine Checkliste mit 42 Punkten, die wichtigsten: DNS-Umstellung um 6 Uhr früh, Smoke-Tests aller Zahlungsarten mit echten Kleinstbeträgen, Redirect-Tabelle aktivieren, Google Search Console neu einreichen. Ein Rollback auf den alten Shop ist bis 48 Stunden nach dem Go-Live möglich, danach werden die alten Server abgeschaltet.

### Offene Fragen an den Kunden
- Wer pflegt nach dem Go-Live die Ratgeberinhalte im CMS? Vorschlag: eine Werkstudentin, Schulung durch mich (zwei Stunden, extra verrechnet)
- Soll es ein Kundenkonto geben oder nur Gastbestellungen? Tendenz: beides, Konto optional
- Newsletter-Anbindung: bisher Mailchimp, ein Wechsel zu Brevo ist im Gespräch
