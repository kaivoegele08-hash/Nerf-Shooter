# Fakemote + Joy-Con (Arbeitsstand)

Dieser Ordner ist eine Kopie von [fakemote](https://github.com/xerpi/fakemote)
(GPL-2.0, Stand `ad98523`) inklusive `embedded-game-controller`. Ziel ist,
Nintendo-Switch-Joy-Cons über das Wii-Bluetooth als Wiimote + MotionPlus in
echten Wii-Spielen nutzbar zu machen.

| Etappe | Ziel | Stand |
|---|---|---|
| 1 | Unverändertes fakemote bauen und als cIOS installieren | in Arbeit |
| 2 | Joy-Con verbindet sich im Hintergrund, Tasten im Spiel | geplant |
| 3 | Beschleunigungssensor als Wiimote-Bewegung | geplant |
| 4 | Gyro als MotionPlus (Wii Sports Resort) | geplant |
| 5 | Zwei Joy-Cons, automatisches Wiederverbinden | geplant |

Gebaut wird `FAKEMOTE.app` per GitHub Actions
(`.github/workflows/wii-fakemote-joycon.yml`).
