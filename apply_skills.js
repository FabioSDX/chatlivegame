const fs = require('fs');
const file = 'index.html';
let content = fs.readFileSync(file, 'utf8');

// 1. Command Box updates
content = content.replace(
    '<div class="cmd-item"><span class="cmd-highlight">tnt</span> / <span class="cmd-highlight">mega tnt</span> —\r\n                boom!</div>',
    '<div class="cmd-item"><span class="cmd-highlight">tnt</span> / <span class="cmd-highlight">mega tnt</span> — boom!</div>\n            <div class="cmd-item"><span class="cmd-highlight">thor</span> — ⚡ lightning</div>\n            <div class="cmd-item"><span class="cmd-highlight">nuke</span> — ☢️ nuke</div>'
);
content = content.replace(
    '<div class="cmd-item"><span class="cmd-highlight">clone</span> — dual pickaxe 10s</div>',
    '<div class="cmd-item"><span class="cmd-highlight">clone</span> — clone army 15s</div>'
);

// 2. Global variables
content = content.replace(
    /(\s*)(var score = 0;)/,
    `$1// ── New Combat Skills State ──\n$1var thorCooldown = 1800;\n$1var nukeCooldown = 1800;\n$1var cloneCooldown = 2400;\n$1var skillCooldowns = {};\n$1var _thorFlashes = [];\n$1var _nukeActive = false;\n$1var _nukeTimer = 0;\n$1var _nukeLocation = {x: 0, y: 0};\n\n$1$2`
);

// 3. Mechanics update hook
content = content.replace(
    /(\s*)(updateZombies\(\);)/,
    `$1var skKeys = Object.keys(skillCooldowns);\n$1for (var ki = 0; ki < skKeys.length; ki++) {\n$1    if (skillCooldowns[skKeys[ki]] > 0) skillCooldowns[skKeys[ki]]--;\n$1}\n$1for (var i = _thorFlashes.length - 1; i >= 0; i--) {\n$1    var fl = _thorFlashes[i];\n$1    fl.timer--;\n$1    fl.alpha = Math.max(0, fl.timer / 30);\n$1    if (fl.timer <= 0) _thorFlashes.splice(i, 1);\n$1}\n$1if (_nukeActive) {\n$1    _nukeTimer--;\n$1    if (_nukeTimer <= 0) _nukeActive = false;\n$1}\n$1$2`
);

// 4. Draw Call Hook + Helper Function definition
content = content.replace(
    /function draw\(\) \{/,
    `function drawPlayerCooldowns(context, px, py, userName) {
            var radius = 22;
            var skills = [{ id: '_thor', color: '#00ffff' }, { id: '_nuke', color: '#ff0000' }, { id: '_clone', color: '#44ffaa' }];
            var cooldownMax = { '_thor': thorCooldown, '_nuke': nukeCooldown, '_clone': cloneCooldown };
            context.save();
            context.translate(px, py);
            context.lineWidth = 3;
            var startAng = -Math.PI / 2;
            for (var i=0; i<skills.length; i++) {
                var key = userName + skills[i].id;
                var timeLeft = skillCooldowns[key] || 0;
                if (timeLeft > 0) {
                    var pct = timeLeft / cooldownMax[skills[i].id];
                    var endAng = startAng + (Math.PI * 2 * pct);
                    context.strokeStyle = skills[i].color;
                    context.globalAlpha = 0.8;
                    context.beginPath();
                    context.arc(0, 0, radius + (i * 4), startAng, endAng);
                    context.stroke();
                }
            }
            context.restore();
        }

        function draw() {`
);

// 5. Draw Avatar Cooldown - Pick
content = content.replace(
    /ctx\.fillText\(pick\.userName, pick\.x \+ 10, oAvY\);\s*\n\s*ctx\.restore\(\);/,
    `ctx.fillText(pick.userName, pick.x + 10, oAvY);\n                    drawPlayerCooldowns(ctx, pick.x - 10 - oAvSize / 2, oAvY, pick.userName);\n                    ctx.restore();`
);

// 6. Draw Avatar Cooldown - userPicks
// Using regex that safely replaces one instance inside userPicks rendering
content = content.replace(
    /ctx\.fillText\(up\.userName, up\.x \+ 10, avY\);\s*\n\s*ctx\.restore\(\);/,
    `ctx.fillText(up.userName, up.x + 10, avY);\n                drawPlayerCooldowns(ctx, up.x - 10 - avSize / 2, avY, up.userName);\n                ctx.restore();`
);

// 7. Draw Thor/Nuke Visuals
content = content.replace(
    /(\n\s*\/\/ explosões TNT[\s\S]*?\})\s*\n\s*ctx\.globalAlpha = 1;\s*\n\s*\/\/ zombies/,
    `$1\n            if (_nukeActive) {
                var nSize = (45 - _nukeTimer) * 50; 
                ctx.save();
                ctx.globalAlpha = _nukeTimer / 45;
                ctx.fillStyle = '#ff2200';
                ctx.beginPath(); ctx.arc(_nukeLocation.x, _nukeLocation.y - camY, nSize, 0, Math.PI*2); ctx.fill();
                ctx.fillStyle = '#ffffff';
                ctx.beginPath(); ctx.arc(_nukeLocation.x, _nukeLocation.y - camY, nSize*0.6, 0, Math.PI*2); ctx.fill();
                ctx.restore();
            }
            for (var tk=0; tk<_thorFlashes.length; tk++) {
                var fl = _thorFlashes[tk];
                ctx.save();
                ctx.globalAlpha = fl.alpha;
                ctx.fillStyle = '#ccffff';
                ctx.fillRect(fl.x - fl.width/2, 0, fl.width, canvas.height);
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(fl.x - fl.width/4, 0, fl.width/2, canvas.height);
                ctx.restore();
            }\n            ctx.globalAlpha = 1;\n\n            // zombies`
);

// 8. spawnClone / Thor / Nuke implementation
let origClone = content.match(/function spawnClone\([\s\S]*?sfxSkillActivate\(\);\s*\n\s*\}/)[0];
let newClone = `function spawnClone(userName, avatarUrl) {
            userName = userName.replace(/^@@+/, '@');
            var cdKey = userName + '_clone';
            if (skillCooldowns[cdKey] && skillCooldowns[cdKey] > 0) return;
            var sourcePick = (ownerName && userName === ownerName) ? pick : userPicks.find(function (up) { return up.userName === userName; });
            if (!sourcePick) return; 

            skillCooldowns[cdKey] = cloneCooldown;
            for(var i=0; i<5; i++) {
                extraPicks.push({
                    x: sourcePick.x + (Math.random() - 0.5) * 60,
                    y: sourcePick.y - 40 - Math.random() * 40,
                    vx: sourcePick.vx + (Math.random() - 0.5) * 8,
                    vy: sourcePick.vy - 4 - Math.random() * 6,
                    ang: sourcePick.ang + Math.random(),
                    spin: (Math.random() - 0.5) * 0.4,
                    stuck: false, stuckTimer: 0,
                    cloneOwner: userName, 
                    cloneAvatar: avatarUrl || sourcePick.userAvatarUrl || '',
                    cloneTimer: 900, // 15s at 60fps
                    clonePickaxe: sourcePick.pickaxe || currentPickaxe,
                    cloneColor: sourcePick.color || persistentScores[userName] && persistentScores[userName].color || '#44ddff'
                });
            }
            spawnText(sourcePick.x, sourcePick.y - 30, '👥 CLONE ARMY!', '#44ffaa');
            if (typeof sfxSkillActivate === 'function') sfxSkillActivate();
        }

        function activateThor(tx, ty, userName) {
            var cdKey = userName + '_thor';
            if (skillCooldowns[cdKey] && skillCooldowns[cdKey] > 0) return;
            skillCooldowns[cdKey] = thorCooldown;

            var targetX = tx !== undefined ? tx : pick.x;
            var col = Math.floor(targetX / TILE);
            _thorFlashes.push({ x: col * TILE + TILE / 2, width: TILE, alpha: 1.0, timer: 30 });
            
            var pts = 0;
            var bottomRow = Math.floor((camY+canvas.height)/TILE) + 2;
            for (var r = Math.max(0, Math.floor(camY/TILE)); r < bottomRow; r++) {
                var cell = getCell(r, col);
                if (cell && cell.t !== E && cell.t !== BEDROCK) {
                    pts += (BDEF[cell.t].pts || 0);
                    spawnParts(col * TILE + TILE / 2, r * TILE + TILE / 2, BDEF[cell.t].glow, 4);
                    cell.t = E; cell.hp = 0; cell.cr = 0;
                }
            }
            if (pts > 0) {
                score += pts;
                spawnText(col * TILE, ty ? ty : camY + canvas.height/2, '+' + pts + ' ⚡', '#00ffff');
                if (userName) {
                    var player = userPicks.find(function (u) { return u.userName === userName; });
                    if (player) player.score = (player.score || 0) + pts;
                    if (!persistentScores[userName]) persistentScores[userName] = { score: 0, avatar: '', color: '#00ffff' };
                    persistentScores[userName].score += pts;
                }
            }
            shakeAmt = Math.max(shakeAmt, 15);
            if (typeof sfxTNT === 'function') sfxTNT();
        }

        function activateNuke(tx, ty, userName) {
            var cdKey = userName + '_nuke';
            if (skillCooldowns[cdKey] && skillCooldowns[cdKey] > 0) return;
            skillCooldowns[cdKey] = nukeCooldown;

            var targetX = tx !== undefined ? tx : pick.x;
            var targetY = ty !== undefined ? ty : pick.y;
            
            _nukeActive = true;
            _nukeTimer = 45;
            _nukeLocation = {x: targetX, y: targetY};

            var b = {
                x: targetX,
                y: targetY - 40,
                vx: (Math.random() - 0.5) * 4,
                vy: -5 - Math.random() * 3,
                ang: Math.random() * Math.PI * 2,
                spin: (Math.random() - 0.5) * 0.2,
                blinkTimer: 0,
                fuse: 70, 
                mega: false, nuke: true,
                userName: userName
            };
            if (typeof tntBlocks !== 'undefined') tntBlocks.push(b);

            spawnText(targetX, targetY - 40, '☢️ MINI-NUKE!', '#ff0000');
            shakeAmt = Math.max(shakeAmt, 10);
            if (typeof sfxTNT === 'function') sfxTNT();
        }`;
// 11. Global Nuke Function Replacement (to avoid duplicates/shadowing)
const nukeBody = `function activateNuke(tx, ty, userName) {
            var cdKey = userName + '_nuke';
            if (skillCooldowns[cdKey] && skillCooldowns[cdKey] > 0) return;
            skillCooldowns[cdKey] = nukeCooldown;

            var targetX = tx !== undefined ? tx : pick.x;
            var targetY = ty !== undefined ? ty : pick.y;
            
            _nukeActive = true;
            _nukeTimer = 45;
            _nukeLocation = {x: targetX, y: targetY};

            var b = {
                x: targetX,
                y: targetY - 40,
                vx: (Math.random() - 0.5) * 4,
                vy: -5 - Math.random() * 3,
                ang: Math.random() * Math.PI * 2,
                spin: (Math.random() - 0.5) * 0.2,
                blinkTimer: 0,
                fuse: 70, 
                mega: false, nuke: true,
                userName: userName
            };
            if (typeof tntBlocks !== 'undefined') tntBlocks.push(b);

            spawnText(targetX, targetY - 40, '☢️ MINI-NUKE!', '#ff0000');
            shakeAmt = Math.max(shakeAmt, 10);
            if (typeof sfxTNT === 'function') sfxTNT();
        }`;

content = content.replace(/function activateNuke\([\s\S]*?\}\s*(?=\n\s*function|\n\s*\/\/|\n\s*$)/g, nukeBody);

// 10. Engine updates for Nuke (Detonation & Rendering)
content = content.replace(
    /var radius = b\.mega \? MEGA_TNT_RADIUS : TNT_RADIUS;/,
    "var radius = b.nuke ? 18 : (b.mega ? MEGA_TNT_RADIUS : TNT_RADIUS);"
);
content = content.replace(
    /var hs = b\.mega \? TILE \* 0\.9 : TILE \* 0\.5;/,
    "var hs = b.nuke ? TILE * 0.3 : (b.mega ? TILE * 0.9 : TILE * 0.5);"
);
content = content.replace(
    /explosions\.push\(\{ x: b\.x, y: b\.y, frame: 0, timer: 0, mega: b\.mega \}\);/,
    "explosions.push({ x: b.x, y: b.y, frame: 0, timer: 0, mega: b.mega, nuke: b.nuke });"
);
content = content.replace(
    /var esize = \(ex\.mega \? MEGA_TNT_RADIUS : TNT_RADIUS\) \* TILE \* 2\.5;/,
    "var rad = ex.nuke ? 18 : (ex.mega ? MEGA_TNT_RADIUS : TNT_RADIUS);\n                    var esize = rad * TILE * 2.5;"
);

fs.writeFileSync(file, content);
console.log('Nuke configuration applied via script');
