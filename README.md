# tracking

this is a web application for testing computer vision techniques on the web

## Map

Open `map.html` and print it (or download the PNG). It shows the floor plan with a QR anchor printed inside
(`map-tl`, `map-tr`, `map-br`, `map-bl`) each of its four corners. When the camera sees all four, every
other card is labelled with the room it is in (kitchen, mouse hole, living room, hallway).
Rooms and anchor positions live in `map.js`.

## Characters

Print `cards.html` for the `MS-01`, `MS-02` (mice) and `HM-01` (human) cards and move them around the map.
Each one reacts to the room it is in, and to meeting another character, with a speech bubble
and a sound (tap the page once to turn sound on):

| | Kitchen | Mouse hole | Living room |
|---|---|---|---|
| MS-01 | I want pizza? | Home sweet home. Safe! | Scared of being killed! |
| MS-02 | Are there vegs? | Home sweet home. Safe! | Scared of being killed! |
| HM-01 | Preparing Food | The wall has a hole. Needs patching! | Relaxing... |

- MS-01 + MS-02 both in the kitchen (together or apart): **Food Stolen!**
- mouse + human close together: **Caught! Game over**
- mouse + mouse close together: **Happy happy!!!**

## Print

Ready-to-print PDFs (letter size, print at 100% / actual size): `print/map.pdf` and `print/cards.pdf`.

## Map on a computer screen

Instead of printing the map, open `display.html` on a computer and press **Fullscreen**.
Scan the pairing code it shows with your phone: that opens the camera page (on the GitHub
Pages site, since phone cameras need HTTPS). Point the phone at the screen so all four corner
codes are in view, and put the MS/HM cards on the screen. The computer draws each character's
reaction right on the map, plus **GAME OVER** when a mouse meets the human, and plays the sounds
(click the page once to enable them). The two devices talk directly using PeerJS.

## Zones: is an object inside the zone?

The camera page has three zone modes (buttons at the bottom, or keys 1-3). Each zone is drawn as an
outline: grey while empty, filled green while a card's centre is inside it.

1. **Halves**: the left and right halves of the camera view.
2. **QR zone**: four QR codes reading `zone:<name>` (print them from `zones.html` or `print/zones.pdf`)
   mark the corners. Same-name markers are joined into a polygon in clockwise order.
3. **Rooms**: the kitchen, mouse hole and living room on the map, located with the map's corner codes.
