# Backyard Wars: Bodycam

A cinematic, bodycam-style tactical foam-dart shooter based on a backyard Nerf war between eight friends. It runs entirely in the browser (Three.js, WebAudio, Web Speech). There's no build step and it uses no external assets: every texture, sound and voice is generated procedurally.

![mode](https://img.shields.io/badge/modes-TDM%20%7C%20Hunt-ff6a00) ![maps](https://img.shields.io/badge/maps-6-1e7bff)

## Run it

Any static file server works. From the repository root:

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000> in a desktop browser (Chrome, Edge or Firefox). Use headphones for the positional audio. ES modules need a server, so opening `index.html` straight from disk won't work. The folder can also be hosted as-is on GitHub Pages.

Quick start for testing: `index.html?auto=kai,tdm,basement` skips the menus. The format is `character,mode,map`. Modes: `tdm`, `hunt`. Maps: `basement`, `forest`, `jurgen`, `soccer`, `garden`, `gardenbasement`.

## The crew

| Character | Personality | Blaster | AI style |
|---|---|---|---|
| **Jason** | The Strategist | Raider-12 pump rifle | Holds angles, calls out positions, coordinates |
| **Kai** | The Rusher | Stryder flywheel (full auto) | Sprints in, close-range brawler |
| **Niklas** | The Sniper | Longreach bolt sniper (zoom) | Patient, long sightlines, camps |
| **Andre** | The Tank | Scatterbox shotgun | Leads pushes, laughs off hits |
| **Jens** | The Trickster | Striker-6 revolver + traps | Flanks constantly, sets dart traps and tripwires |
| **Chris** | The Medic | Raider-12 pump rifle | Prioritises revives and revives fastest |
| **Yogi** | The Wildcard | Twin pocket blasters | Chaotic: random detours, taunts, trips over nothing |
| **Luca** | The Lurker | Scatterbox shotgun | Hides in corners, ambushes |

You pick one character. The other seven are AI. **Teams are re-randomised every round**, so a character can be your teammate one round and your opponent the next. Each character has their own voice lines (text-to-speech with a per-character pitch and rate), movement speed, head-bob, accuracy, reaction time, aggression, patience and flanking tendency.

## Rules: lives, downed, revive

- Everyone starts with **3 lives**. Each dart hit costs one, and you're briefly invulnerable afterwards.
- With lives left you're **injured** but still fighting.
- Lose all 3 and you're **downed**: you drop to your knees on the spot and can't move or shoot.
- A teammate can **revive** you by holding `E` next to you (Chris is faster). You return with **1 life**.
- Lose that last life and you're **eliminated** for the round. You then spectate your teammates' bodycams.
- A downed player who isn't revived before the bleed-out timer runs out (45 s by default) is eliminated.
- A team with nobody left standing loses, even if some of them are only downed.

## Game modes

**Team Deathmatch** (primary map: Basement). It's 4v4 and the last team with someone standing wins. If time runs out, the team with the most remaining lives wins.

**Hunt** (primary map: Forest)
1. **Preparation phase.** The hiders spread out, build **barricades** (`F`) and place **dart traps** (`G`) and **tripwire alarms** (`T`). AI hiders choose hide spots, often in bushes, and trap the approach routes. The hunters count with "their hand over the lens", so the screen goes black and the audio is muffled.
2. **Hunting phase.** The hunters sweep the map. Sprinting leaves **footprints** that they can follow, and tripwires reveal positions to the team that placed them. In the last minute an **extraction point** opens. The hiders win if anyone survives or escapes.

## Maps

- **Basement:** stairwell, laundry, workshop, furnace room, hallway, rec room (ping pong table, couch, TV glow), storage shelf maze, bathroom and bar. Low ceilings and flickering fluorescent tubes.
- **Forest:** hilly terrain, about 330 trees, bushes that block sight, trails, rocks, fallen logs, a climbable hunting stand, an old shack and an abandoned tent.
- **Jürgen Forest:** misty woods containing **Jürgen's** palisade compound (hut, campfire, warning signs).
- **Soccer Field:** open pitch, goals, free-kick walls, dugouts, bleachers, containers and a ball you can kick.
- **Garden:** patio, trampoline, hedges, an enterable shed, a glass greenhouse, raised beds, a playhouse and a dog house (the dog barks).
- **Garden + Basement:** the garden connects to a walk-out basement through the patio sliding door, outdoor cellar steps and a **crawl-only window**.

## Jürgen

Jürgen is a neutral NPC with a katana who doesn't follow team rules. He patrols his base and charges at **anyone** who enters, shouting in German. One katana hit costs a life and knocks you back. He investigates gunfire near his fence, so you can lure enemies into his zone. Hit him four times in quick succession and he sits down for a breather, then comes back angry. AI characters path around his territory, mostly.

## Bodycam presentation

- Chest-mounted camera with stride bob, a handheld micro-shake, landing jolts and trauma shake when you're hit.
- Lens shader with barrel/fisheye distortion, chromatic aberration, directional motion blur from camera rotation, temporal sensor smear, low-light auto-gain noise, vignette, faint interlace and a glitch effect on impact.
- HUD styled like bodycam overlays: blinking REC, unit and camera ID, a live timestamp, battery percentage, GPS/AUD status, a team-radio indicator, location callouts and the teammate radio roster.
- The first-person blaster and hands are rendered in their own pass so they never clip into walls.

## Audio

All audio is procedural WebAudio with HRTF positional sound. It includes plunger "thwumps", flywheel whine, priming slides, reload clicks, dart impacts that depend on the surface, footsteps for each surface type (concrete, carpet, grass, leaves, gravel, wood, metal), breathing that follows exertion and stress, a heartbeat when hunters are close, clothing rustle, radio squelch and static, and ambience (basement hum, wind, birds, crows in the mist). Voice lines use the browser's speech synthesis: teammates come through the radio with static, and enemies are heard only up close.

## AI

- **Perception:** a vision cone with line-of-sight checks and a "spotting meter" affected by distance, crouching, movement, bushes, lighting and muzzle flash. Gunshots, footsteps and alarms can be heard.
- **Team intel:** spotted enemies are shared through radio callouts that name the location ("Contact, Laundry!").
- **Combat:** ballistic aim with lead and drop compensation, error that depends on skill, trigger discipline, strafing, crouch-peeking and reload-to-cover.
- **Tactics:** cover search (sampled positions hidden from the threat), a rotating team flanker, ambush and camping for patient characters, revives with bravery checks, and a **danger heat map** so the AI avoids angles where it got shot. Pathfinding is A* on a navigation grid with path smoothing.
- **Hunt behaviour:** hiders set up barricades and traps, then hide. Hunters sweep the map, follow footprints and investigate noises.
- **Personality flavour:** Yogi trips, Mom calls everyone for dinner in the basement maps, the neighbour complains, and friends complain about friendly fire.

After each round the **footage review** lists the round's story in order (first blood, revives under fire, trap victims, Jürgen incidents, clutches and jams), plus an MVP and a scoreboard with round wins carried across the session.

## Controls

| Key | Action |
|---|---|
| WASD / Mouse | Move / look |
| LMB / RMB | Fire / aim down sights (sniper zooms) |
| Shift / C or Ctrl / Space | Sprint / crouch (hold) / jump |
| R | Reload |
| E (hold) | Revive a downed teammate |
| Z or Q | Call out the enemy you're looking at, or ping a spot |
| 1 / 2 / 3 | Order AI teammates: Follow me / Hold / Push |
| F / G / T | Barricade / dart trap / tripwire (Hunt prep, and Jens) |
| H | Call for help while downed |
| V | Taunt |
| Tab | Scoreboard |
| ← → (or A/D, click) | Switch bodycam while spectating |
| Esc | Pause |

## Notes

- This is a single-human experience: you play alongside and against seven AI friends. Online networked multiplayer isn't implemented.
- The settings screen covers sensitivity, FOV, AI difficulty, spoken voices on or off, lens distortion, shake, motion blur, grain, Hunt prep time and the bleed-out timer.
- Project layout: `src/world.js` (collision, raycasts, nav grid and A*), `src/maps.js` (all six maps), `src/characters.js` (roster, blasters, voice lines), `src/actor.js` (bodies and movement), `src/ai.js` (AI brains), `src/jurgen.js`, `src/weapons.js` (darts, traps, barricades), `src/bodycam.js` (camera rig, viewmodel, lens shader), `src/audio.js`, `src/hud.js`, `src/game.js` (rules and modes), `src/main.js` (menus, input, loop). Three.js r170 is vendored in `lib/` under its MIT license.
