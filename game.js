const canvas = document.querySelector("#gameCanvas");
const ctx = canvas.getContext("2d");
const status = document.querySelector("#status");
const progress = document.querySelector("#progress");
const restartButton = document.querySelector("#restartButton");

const WORLD_WIDTH = 3600;
const GRAVITY = 0.65;
const keys = new Set();
let cameraX = 0;
let gameState;
let jumpWasPressed = false;

const platforms = [
    { x: 0, y: 455, width: 700, height: 85 },
    { x: 810, y: 420, width: 390, height: 120 },
    { x: 1310, y: 360, width: 360, height: 180 },
    { x: 1780, y: 450, width: 520, height: 90 },
    { x: 2420, y: 390, width: 430, height: 150 },
    { x: 2980, y: 450, width: 620, height: 90 },
    { x: 530, y: 350, width: 130, height: 24 },
    { x: 980, y: 300, width: 150, height: 24 },
    { x: 1510, y: 220, width: 140, height: 24 },
    { x: 2030, y: 330, width: 170, height: 24 },
    { x: 2670, y: 270, width: 150, height: 24 },
];

function createState() {
    return {
        player: { x: 90, y: 380, width: 28, height: 42, vx: 0, vy: 0, grounded: false, jumpsUsed: 0 },
        enemies: [
            { x: 1040, y: 375, width: 32, height: 35, vx: 1.1, left: 900, right: 1160 },
        ],
        stars: [
            { x: 600, y: 310, collected: false },
            { x: 1570, y: 180, collected: false },
            { x: 2740, y: 230, collected: false },
        ],
        goal: { x: 3450, y: 390 },
        won: false,
        lost: false,
    };
}

function resetGame() {
    gameState = createState();
    cameraX = 0;
    jumpWasPressed = false;
    status.textContent = "";
    updateProgress();
}

function isDown(...names) {
    return names.some((name) => keys.has(name));
}

function intersects(a, b) {
    return a.x < b.x + b.width && a.x + a.width > b.x &&
        a.y < b.y + b.height && a.y + a.height > b.y;
}

function update() {
    if (gameState.won || gameState.lost) return;
    const player = gameState.player;
    const direction = (isDown("ArrowRight", "d") ? 1 : 0) - (isDown("ArrowLeft", "a") ? 1 : 0);
    player.vx += direction * 0.75;
    player.vx *= direction ? 0.84 : 0.78;
    player.vx = Math.max(-5, Math.min(5, player.vx));

    const jumpPressed = isDown(" ", "ArrowUp", "w");
    if (jumpPressed && !jumpWasPressed && player.jumpsUsed < 2) {
        player.vy = -12;
        player.grounded = false;
        player.jumpsUsed += 1;
    }
    jumpWasPressed = jumpPressed;

    player.vy += GRAVITY;
    const previousBottom = player.y + player.height;
    player.x = Math.max(0, Math.min(WORLD_WIDTH - player.width, player.x + player.vx));
    player.y += player.vy;
    player.grounded = false;

    for (const platform of platforms) {
        const fallingOnto = player.vy >= 0 && previousBottom <= platform.y &&
            player.y + player.height >= platform.y &&
            player.x + player.width > platform.x && player.x < platform.x + platform.width;
        if (fallingOnto) {
            player.y = platform.y - player.height;
            player.vy = 0;
            player.grounded = true;
            player.jumpsUsed = 0;
        }
    }

    for (const enemy of gameState.enemies) {
        enemy.x += enemy.vx;
        if (enemy.x <= enemy.left || enemy.x >= enemy.right) enemy.vx *= -1;
        if (intersects(player, enemy)) {
            gameState.lost = true;
            status.textContent = "やられてしまった… Rキーかボタンでリトライ";
        }
    }

    for (const star of gameState.stars) {
        const pickup = { x: star.x - 11, y: star.y - 11, width: 22, height: 22 };
        if (!star.collected && intersects(player, pickup)) star.collected = true;
    }

    if (player.y > canvas.height + 120) {
        gameState.lost = true;
        status.textContent = "落ちてしまった… Rキーかボタンでリトライ";
    }
    if (player.x + player.width > gameState.goal.x && player.y < gameState.goal.y + 80) {
        gameState.won = true;
        status.textContent = "ステージクリア！ Rキーかボタンでもう一度";
    }

    cameraX += (player.x - cameraX - 300) * 0.08;
    cameraX = Math.max(0, Math.min(WORLD_WIDTH - canvas.width, cameraX));
    updateProgress();
}

function updateProgress() {
    const collected = gameState.stars.filter((star) => star.collected).length;
    progress.textContent = `スター: ${collected} / ${gameState.stars.length}`;
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const sky = ctx.createLinearGradient(0, 0, 0, canvas.height);
    sky.addColorStop(0, "#73d9f5");
    sky.addColorStop(0.55, "#b9a4f5");
    sky.addColorStop(1, "#ff9fcf");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(-cameraX, 0);
    drawBackground();
    for (const platform of platforms) drawPlatform(platform);
    for (const star of gameState.stars) if (!star.collected) drawStar(star.x, star.y);
    drawGoal();
    for (const enemy of gameState.enemies) drawEnemy(enemy);
    drawPlayer(gameState.player);
    ctx.restore();
}

function drawBackground() {
    ctx.fillStyle = "#7771c0";
    for (let x = -200; x < WORLD_WIDTH; x += 300) {
        ctx.beginPath();
        ctx.moveTo(x, 455);
        ctx.lineTo(x + 160, 250);
        ctx.lineTo(x + 360, 455);
        ctx.fill();
    }
    ctx.fillStyle = "#fff6c7";
    for (let x = 80; x < WORLD_WIDTH; x += 280) {
        ctx.beginPath();
        ctx.arc(x, 85 + (x % 3) * 20, 2, 0, Math.PI * 2);
        ctx.fill();
    }
    for (let x = 190; x < WORLD_WIDTH; x += 520) {
        drawCloud(x, 135 + (x % 2) * 55);
    }
}

function drawPlatform(platform) {
    ctx.fillStyle = "#3a2861";
    ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
    ctx.fillStyle = "#7ee8d2";
    ctx.fillRect(platform.x, platform.y, platform.width, 9);
    ctx.fillStyle = "#d6a7f4";
    ctx.fillRect(platform.x, platform.y + 9, platform.width, 5);
}

function drawPlayer(player) {
    ctx.fillStyle = "#ff9fcf";
    ctx.beginPath();
    ctx.arc(player.x + 14, player.y + 15, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff1fb";
    ctx.fillRect(player.x + 4, player.y + 24, 20, 15);
    ctx.fillStyle = "#5a3679";
    ctx.fillRect(player.x + 8, player.y + 14, 4, 5);
    ctx.fillRect(player.x + 18, player.y + 14, 4, 5);
    ctx.fillStyle = "#f36eae";
    ctx.fillRect(player.x - 4, player.y + 7, 5, 17);
    ctx.fillRect(player.x + 27, player.y + 7, 5, 17);
    drawHeart(player.x + 14, player.y + 30, 5, "#ff77bb");
    ctx.fillStyle = "#d979c7";
    ctx.fillRect(player.x + 3, player.y + player.height, 8, 4);
    ctx.fillRect(player.x + 18, player.y + player.height, 8, 4);
}

function drawEnemy(enemy) {
    ctx.fillStyle = "#8f72db";
    ctx.beginPath();
    ctx.arc(enemy.x + 16, enemy.y + 18, 17, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.fillRect(enemy.x + 6, enemy.y + 12, 7, 7);
    ctx.fillRect(enemy.x + 20, enemy.y + 12, 7, 7);
    ctx.fillStyle = "#49316d";
    ctx.fillRect(enemy.x + 8, enemy.y + 14, 3, 3);
    ctx.fillRect(enemy.x + 22, enemy.y + 14, 3, 3);
    drawHeart(enemy.x + 16, enemy.y + 29, 4, "#ffabc9");
}

function drawStar(x, y) {
    ctx.fillStyle = "#ffe66d";
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
        const angle = -Math.PI / 2 + i * Math.PI / 5;
        const radius = i % 2 ? 7 : 14;
        const pointX = x + Math.cos(angle) * radius;
        const pointY = y + Math.sin(angle) * radius;
        i ? ctx.lineTo(pointX, pointY) : ctx.moveTo(pointX, pointY);
    }
    ctx.closePath();
    ctx.fill();
}

function drawGoal() {
    const { x, y } = gameState.goal;
    ctx.fillStyle = "#fff0b5";
    ctx.fillRect(x, y, 7, 60);
    ctx.fillStyle = "#ff83bd";
    ctx.beginPath();
    ctx.moveTo(x + 7, y);
    ctx.lineTo(x + 58, y + 16);
    ctx.lineTo(x + 7, y + 32);
    ctx.fill();
    drawHeart(x + 30, y - 18, 10, "#ffdb74");
}

function drawHeart(x, y, size, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y + size);
    ctx.bezierCurveTo(x - size * 1.6, y, x - size, y - size, x, y);
    ctx.bezierCurveTo(x + size, y - size, x + size * 1.6, y, x, y + size);
    ctx.fill();
}

function drawCloud(x, y) {
    ctx.fillStyle = "#ffffffaa";
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.arc(x + 25, y - 10, 30, 0, Math.PI * 2);
    ctx.arc(x + 60, y, 22, 0, Math.PI * 2);
    ctx.fill();
}

function gameLoop() {
    update();
    draw();
    requestAnimationFrame(gameLoop);
}

window.addEventListener("keydown", (event) => {
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
    keys.add(event.key);
    if (event.key.toLowerCase() === "r") resetGame();
});
window.addEventListener("keyup", (event) => keys.delete(event.key));
restartButton.addEventListener("click", resetGame);

resetGame();
gameLoop();
