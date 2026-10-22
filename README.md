# tracking

this is a web application for testing computer vision techniques on the web

## Map

Open `map.html` and print it (or download the PNG). It shows the floor plan with a QR anchor printed inside
(`map-tl`, `map-tr`, `map-br`, `map-bl`) each of its four corners. When the camera sees all four, every
other card is labelled with the room it is in (kitchen, mouse hole, living room, hallway).
Rooms and anchor positions live in `map.js`.

## Characters

Print `cards.html` for the `mouse-1`, `mouse-2` and `human` cards and move them around the map.
Each one reacts to the room it is in, and to meeting another character, with a speech bubble
and a sound (tap the page once to turn sound on):

| | Kitchen | Mouse hole | Living room |
|---|---|---|---|
| mouse | Food stolen! | Home sweet home. Safe! | Scared of being killed! |
| human | Preparing food | The wall has a hole. Needs patching! | Relaxing... |

- mouse + human close together: **Caught! Game over**
- mouse + mouse close together: **Happy happy!!!**
