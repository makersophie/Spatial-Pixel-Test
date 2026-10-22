# tracking

this is a web application for testing computer vision techniques on the web

## Map

Open `map.html` and print it (or download the PNG). It shows the floor plan with a QR anchor
(`map-tl`, `map-tr`, `map-br`, `map-bl`) at each corner. When the camera sees all four, every
other card is labelled with the room it is in (kitchen, mouse hole, living room, hallway).
Rooms and anchor positions live in `map.js`.
