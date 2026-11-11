# Joy-Con Bridge für die Wii (Homebrew Channel)

Ein Homebrew-Programm, das **Nintendo Switch Joy-Cons** (und den Pro Controller)
per Bluetooth direkt mit der Wii verbindet und ihre **Bewegungssteuerung**
(Beschleunigungssensor + Gyroskop) ausliest. Die Gyro-Daten werden zusätzlich
im **Wii-MotionPlus-Format** ausgegeben. Eine echte Wii-Fernbedienung mit
MotionPlus kann gleichzeitig verbunden werden – die Werte stehen dann zum
Vergleich direkt darunter.

> **Wichtig, ehrlich gesagt:** Das Programm wurde **noch nicht auf echter
> Hardware getestet** (es ist frisch geschrieben). Es ist gegen die aktuellen
> libogc-Header geprüft, der GitHub-Actions-Workflow baut die `boot.dol`.
> Siehe [Bekannte Grenzen](#bekannte-grenzen).

## Was es kann

- Joy-Con (L), Joy-Con (R) und Pro Controller finden und verbinden (bis zu 4)
- Liest Tasten, Sticks (mit Werkskalibrierung aus dem Joy-Con-Flash), Akku
- Liest den 6-Achsen-IMU mit 200 Hz (Beschleunigung in G, Drehrate in °/s)
- Nutzt die Werks- bzw. Benutzer-IMU-Kalibrierung aus dem SPI-Flash
- Misst nach dem Verbinden automatisch den Gyro-Bias (1 s ruhig liegen lassen)
- Rechnet die Lage (Pitch / Roll / Yaw) mit einem Komplementärfilter
- Gibt die Drehraten als **MotionPlus-Rohwerte** aus (8192 = Ruhe,
  ~20 Einheiten pro °/s, „slow“/„fast“-Modus wie beim echten MotionPlus)
- Achsen sind auf das Koordinatensystem der Wii-Fernbedienung umgerechnet
  (Joy-Con senkrecht halten wie eine Wiimote)
- Achsen-Assistent, falls eine Achse verdreht ist – wird auf SD gespeichert
- Rumble, Spieler-LEDs
- Wii-Fernbedienungen (inkl. MotionPlus) funktionieren gleichzeitig über WPAD

## Bauen

Mit [devkitPro](https://devkitpro.org/wiki/Getting_Started) (devkitPPC + libogc + libfat):

```bash
cd wii-joycon-bridge
```

```bash
make dist
```

Ergebnis: `dist/apps/joycon-bridge/` mit `boot.dol`, `meta.xml`, `icon.png`.

Ohne eigene Toolchain: Der Workflow `.github/workflows/wii-joycon-bridge.yml`
baut das Programm bei jedem Push automatisch. Unter
**GitHub → Actions → „Wii Joy-Con Bridge“ → Artifacts** gibt es den fertigen
SD-Karten-Ordner `joycon-bridge-sd` als ZIP.

## Installieren

1. Den Ordner `apps/joycon-bridge` auf die SD-Karte kopieren
   (→ `SD:/apps/joycon-bridge/boot.dol`).
2. SD-Karte in die Wii, Homebrew Channel starten, **Joy-Con Bridge** wählen.

## Benutzung

1. Programm starten – die Suche läuft automatisch.
2. Am Joy-Con die **kleine runde Sync-Taste an der Schiene** gedrückt halten,
   bis die grünen LEDs hin und her laufen.
3. Nach dem Verbinden leuchtet die Spieler-LED, der Joy-Con vibriert kurz.
4. Joy-Con **ruhig hinlegen**, bis „bereit“ erscheint (Gyro-Kalibrierung, ~1 s).

Nach jedem Neustart muss der Joy-Con wieder per Sync-Taste verbunden werden
(siehe Grenzen).

### Tasten

| Controller | Taste | Funktion |
|---|---|---|
| Joy-Con | HOME / Capture kurz | Lage zentrieren (Yaw = 0) |
| Joy-Con | HOME / Capture 2 s halten | Beenden |
| Joy-Con | Stick drücken | Gyro neu kalibrieren (ruhig halten) |
| Joy-Con | + / − | Achsen-Assistent starten / bestätigen |
| Joy-Con | SL + SR | Rumble-Test |
| Joy-Con | ZL + ZR | Suche an/aus |
| Wiimote | HOME | Beenden |
| Wiimote | 1 | Suche an/aus |
| GameCube | START / X | Beenden / Suche an/aus |

### Achsen prüfen / Achsen-Assistent

Wenn der Joy-Con flach mit den Tasten nach oben liegt, sollte
**Accel Z ≈ +1.00** sein. Zeigt das obere Ende (L/ZL bzw. R/ZR) zur Decke,
sollte **Accel Y ≈ +1.00** sein. Stimmt das nicht:

1. **+ / −** am betroffenen Joy-Con drücken.
2. Joy-Con flach hinlegen (Tasten oben) → **+ / −**.
3. Joy-Con senkrecht halten, oberes Ende zur Decke → **+ / −**.

Die Zuordnung wird in `SD:/apps/joycon-bridge/axes.cfg` gespeichert und beim
nächsten Start geladen.

## In eigenen Homebrew-Programmen benutzen

`source/joycon.c` / `source/joycon.h` sind eine eigenständige Bibliothek:

```c
#include <wiiuse/wpad.h>
#include "joycon.h"

WPAD_Init();                 // startet den Bluetooth-Stack
JC_Init();
JC_StartScan();

while (1) {
    WPAD_ScanPads();
    JC_Update();             // einmal pro Frame
    const jc_state_t *jc = JC_GetState(0);
    if (jc->status == JC_STATUS_READY) {
        // jc->gyro.x/y/z  (°/s)      jc->accel.x/y/z (G)
        // jc->mp.rx/ry/rz (MotionPlus-Rohwerte, wie struct motion_plus_t)
        // jc->pitch/roll/yaw (Grad), jc->buttons (JC_BTN_*)
    }
    VIDEO_WaitVSync();
}
```

## Wie es funktioniert

- Die Wii hat ein Bluetooth-2.0-Modul. libogc spricht es über den
  lwBT-Stack (`bte`) an – derselbe Stack, den WPAD für Wiimotes nutzt.
- Das Programm macht eine Bluetooth-Inquiry, liest die Gerätenamen
  („Joy-Con (L)“, „Joy-Con (R)“, „Pro Controller“) und öffnet die
  HID-L2CAP-Kanäle 0x11/0x13 (`bte_connectasync`).
- Danach Joy-Con-Protokoll: Geräteinfo (0x02), Kalibrierung aus dem
  SPI-Flash (0x10 @ 0x6020, 0x603D, 0x8010, 0x8026), IMU an (0x40),
  Vibration an (0x48), Report-Modus 0x30 (Tasten + 3 IMU-Samples),
  Spieler-LEDs (0x30).
- Die Bluetooth-Callbacks laufen im Interrupt-Kontext und kopieren nur
  Rohdaten in einen Ringpuffer; ausgewertet wird in `JC_Update()`.

## Bekannte Grenzen

- **Nicht auf Hardware getestet.** Bitte Rückmeldung, was im Log unten auf
  dem Bildschirm steht, falls etwas nicht klappt.
- **Pairing:** Das Wii-Bluetooth-Modul kann kein „Secure Simple Pairing“
  (kam erst mit Bluetooth 2.1). libogc nutzt Legacy-PIN-Pairing. Falls ein
  Joy-Con das ablehnt, steht im Log „Verbindung abgelehnt“ – das wäre dann
  eine Hardware-/Firmware-Grenze, die sich nur durch Anpassungen im
  libogc-Bluetooth-Stack umgehen ließe.
- **Kein automatisches Wiederverbinden:** WPAD besitzt den einzigen
  „Connection Request“-Callback von libogc. Joy-Cons werden deshalb immer
  von der Wii aus verbunden → bei jedem Start Sync-Taste drücken.
- **Nur innerhalb von Homebrew:** Dieses Programm (bzw. die Bibliothek)
  macht Joy-Cons in Homebrew nutzbar. **Echte Wii-Spiele** sehen die Joy-Cons
  dadurch nicht als Wiimote + MotionPlus – dafür wäre ein IOS-Modul nötig,
  das eine Wiimote auf Bluetooth-Ebene emuliert (Ansatz wie bei
  *fakemote* für cIOS d2x). Die MotionPlus-Kodierung hier (`jc->mp`) ist als
  Vorarbeit dafür gedacht.
- **Yaw driftet** langsam (kein Magnetometer) → HOME/Capture zum Zentrieren.
- Die Vorzeichen der MotionPlus-Werte sind auf die libogc-Konvention
  (rx = Pitch, ry = Roll, rz = Yaw) ausgelegt; mit einer echten
  Wiimote + MotionPlus direkt darunter lässt sich das gut vergleichen.
