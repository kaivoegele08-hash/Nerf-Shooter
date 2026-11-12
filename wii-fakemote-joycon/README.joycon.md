# Fakemote + Joy-Con (Arbeitsstand)

Dieser Ordner ist eine Kopie von [fakemote](https://github.com/xerpi/fakemote)
(GPL-2.0, Stand `ad98523`) inklusive `embedded-game-controller`. Ziel ist,
Nintendo-Switch-Joy-Cons über das Wii-Bluetooth als Wiimote + MotionPlus in
echten Wii-Spielen nutzbar zu machen.

| Etappe | Ziel | Stand |
|---|---|---|
| 1 | Unverändertes fakemote bauen und als cIOS installieren | fertig (cIOS 247, Basis 58) |
| 2 | Joy-Con verbindet sich im Hintergrund, Tasten im Spiel | erste Version, ungetestet |
| 3 | Beschleunigungssensor als Wiimote-Bewegung | geplant |
| 4 | Gyro als MotionPlus (Wii Sports Resort) | geplant |
| 5 | Zwei Joy-Cons, automatisches Wiederverbinden | geplant |

Gebaut wird `FAKEMOTE.app` per GitHub Actions
(`.github/workflows/wii-fakemote-joycon.yml`).

## Etappe 2: wie es funktioniert

- `source/bt_host.c`: fakemote schickt eigene HCI-Befehle und ACL-Pakete an
  den Bluetooth-Chip und versteckt alle Events/Pakete der eigenen
  Verbindungen vor dem Spiel.
- `source/joycon_bt.c`: verbindet die Joy-Cons aus
  `/shared2/fakemote_joycon.bin` (wird von der Joy-Con-Bridge-App
  geschrieben), Legacy-Pairing mit PIN = Wii-Bluetooth-Adresse, L2CAP-HID,
  Joy-Con-Initialisierung, dann als Eingabegerät für eine Fake-Wiimote.

Tastenbelegung (Joy-Con R senkrecht wie eine Wiimote):

| Joy-Con | Wiimote |
|---|---|
| A | A |
| ZR / R | B |
| Y / SL | 1 |
| B / SR | 2 |
| + | + |
| X | − |
| HOME | HOME |
| Stick | Zeiger (IR) |
| Stick gedrückt + Stick | Steuerkreuz |
