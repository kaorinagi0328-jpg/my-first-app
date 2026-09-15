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
        player: { x: 90, y: 380, width: 28, height: 42, vx: 0, vy: 0, grounded: false },
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

    if (isDown(" ", "ArrowUp", "w") && player.grounded) {
        player.vy = -12;
        player.grounded = false;
    }

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
    sky.addColorStop(0, "#171b46");
    sky.addColorStop(1, "#51306b");
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
    ctx.fillStyle = "#252356";
    for (let x = -200; x < WORLD_WIDTH; x += 300) {
        ctx.beginPath();
        ctx.moveTo(x, 455);
        ctx.lineTo(x + 160, 250);
        ctx.lineTo(x + 360, 455);
        ctx.fill();
    }
    ctx.fillStyle = "#f8e8a9";
    for (let x = 80; x < WORLD_WIDTH; x += 280) {
        ctx.beginPath();
        ctx.arc(x, 85 + (x % 3) * 20, 2, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawPlatform(platform) {
    ctx.fillStyle = "#2e2351";
    ctx.fillRect(platform.x, platform.y, platform.width, platform.height);
    ctx.fillStyle = "#54c6a9";
    ctx.fillRect(platform.x, platform.y, platform.width, 9);
    ctx.fillStyle = "#3f8b7e";
    ctx.fillRect(platform.x, platform.y + 9, platform.width, 5);
}

function drawPlayer(player) {
    ctx.fillStyle = "#ffcf67";
    ctx.fillRect(player.x, player.y, player.width, player.height);
    ctx.fillStyle = "#33285d";
    ctx.fillRect(player.x + 6, player.y + 10, 5, 5);
    ctx.fillRect(player.x + 18, player.y + 10, 5, 5);
    ctx.fillStyle = "#ff7d8a";
    ctx.fillRect(player.x - 4, player.y + 5, 5, 18);
    ctx.fillStyle = "#f58e58";
    ctx.fillRect(player.x + 4, player.y + player.height, 8, 4);
    ctx.fillRect(player.x + 18, player.y + player.height, 8, 4);
}

function drawEnemy(enemy) {
    ctx.fillStyle = "#ee687f";
    ctx.fillRect(enemy.x, enemy.y, enemy.width, enemy.height);
    ctx.fillStyle = "#fff";
    ctx.fillRect(enemy.x + 6, enemy.y + 9, 7, 7);
    ctx.fillRect(enemy.x + 20, enemy.y + 9, 7, 7);
    ctx.fillStyle = "#33285d";
    ctx.fillRect(enemy.x + 8, enemy.y + 11, 3, 3);
    ctx.fillRect(enemy.x + 22, enemy.y + 11, 3, 3);
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
    ctx.fillStyle = "#f4e7bc";
    ctx.fillRect(x, y, 7, 60);
    ctx.fillStyle = "#ff7d8a";
    ctx.beginPath();
    ctx.moveTo(x + 7, y);
    ctx.lineTo(x + 58, y + 16);
    ctx.lineTo(x + 7, y + 32);
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
