# Copilot instructions for `my-first-app`

## Project overview

This repository is a dependency-free static web game called **Star Runner**. The browser loads `index.html`, which links the presentation layer in `style.css` and the game implementation in `game.js`.

The game is rendered into the fixed-size `#gameCanvas` element and scaled responsively by CSS. `game.js` owns the complete runtime: it defines the level geometry, creates and resets game state, processes keyboard input, applies physics and collision checks, updates the camera, and draws the background and entities every animation frame. The HTML status overlay and progress label are updated directly from that same state. Keep gameplay behavior in JavaScript rather than embedding it in markup or CSS.

## Commands

There is no package manager configuration, build script, test runner, or linter in this repository. Run the game by opening `index.html` in a browser or serving the repository with any simple static HTTP server.

The available syntax check for the game code is:

```sh
node --check game.js
```

There are no individual tests to run. For behavior changes, manually exercise movement, jumping, platform landing, enemy collision, star collection, falling, reaching the goal, and restart (`R` or the restart button) in a browser.

## Code conventions and change guidance

- Keep the three-layer split intact: structure and accessible status text in `index.html`, layout/visual styling in `style.css`, and game rules/rendering/input in `game.js`.
- Use the existing plain JavaScript style: module-level constants for immutable level configuration, a `gameState` object for mutable runtime state, small functions for update/draw responsibilities, and `requestAnimationFrame(gameLoop)` for the main loop.
- World coordinates are separate from the 960x540 canvas viewport. Update world entities in `gameState`, use `cameraX` for horizontal scrolling, and draw world content inside the existing translated canvas context.
- Add level geometry to `platforms` and entity starting positions to `createState()`. Resettable state belongs in `createState()` so `resetGame()` can reliably restore a complete stage.
- Preserve the current keyboard aliases (`ArrowLeft`/`ArrowRight` and `a`/`d` for movement; `Space`/`ArrowUp` and `w` for jumping) and prevent browser scrolling for handled keys.
- Preserve the terminal-state flow: `gameState.won` and `gameState.lost` stop updates, while the status overlay communicates the result and reset clears it.
- Use the existing DOM IDs (`gameCanvas`, `status`, `progress`, and `restartButton`) when connecting UI to the game. Update the star counter through `updateProgress()` rather than duplicating its calculation.
- Keep visual constants and drawing logic consistent with the current pixel-art aesthetic. Do not introduce image or library dependencies unless the project is intentionally converted away from its current dependency-free setup.
- 表示する説明やユーザー向けテキストは日本語にする。既存のページ言語と操作説明に合わせる。
