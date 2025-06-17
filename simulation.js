// ===================================================================================
// --- Global Variables & Constants ---
// ===================================================================================
const canvas = document.getElementById('simulationCanvas');
const ctx = canvas.getContext('2d');

let PARAMS = {};

const TICKS_PER_SECOND = 30;
const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_DAY = 86400;

const DISTRIBUTION_WEIGHTS = {
    wave: [0.01, 0.01, 0.01, 0.01, 0.02, 0.04, 0.06, 0.08, 0.09, 0.07, 0.06, 0.05, 0.05, 0.06, 0.07, 0.08, 0.09, 0.06, 0.04, 0.02, 0.01, 0.01, 0.01, 0.01],
    spike: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.02, 0.03, 0.04, 0.15, 0.25, 0.15, 0.10, 0.05, 0.03, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01],
};

const PROCESS_FLOW = [
    'self_access_control_arrival',
    'access_control_arrival',
    'self_arrival_handling',
    'arrival_handling',
    'execution',
    'self_departure_handling',
    'departure_handling',
    'self_access_control_departure',
    'access_control_departure'
];
const serverPoints = {};
let pathDefinitions = {};


let truckIdCounter, simulationTime, trucks, animationFrameId, isRunning;
let completedTrucksData = [];

// ===================================================================================
// --- Core Simulation Logic (Functions) ---
// ===================================================================================

function randomFloat(min, max) { return Math.random() * (max - min) + min; }
function capitalizeWords(str) {
    return str.replace(/_/g, ' ').replace(/\w\S*/g, (txt) => txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase());
}

function getPath(fromKey, toKey) {
    return JSON.parse(JSON.stringify(pathDefinitions[`${fromKey}->${toKey}`] || []));
}


function generateHourlySchedule(totalTrucks, type, openingHour, closingHour) {
    const schedule = new Array(24).fill(0);
    const operatingHours = closingHour - openingHour;
    if (operatingHours <= 0) { return schedule; }
    if (type === 'even') {
        const trucksPerHour = totalTrucks / operatingHours;
        for (let i = openingHour; i < closingHour; i++) schedule[i] = Math.round(trucksPerHour);
    } else {
        const weights = DISTRIBUTION_WEIGHTS[type];
        const relevantWeights = weights.slice(openingHour, closingHour);
        const sumOfRelevantWeights = relevantWeights.reduce((sum, w) => sum + w, 0);
        if (sumOfRelevantWeights === 0) return generateHourlySchedule(totalTrucks, 'even', openingHour, closingHour);
        const rescaledWeights = relevantWeights.map(w => w / sumOfRelevantWeights);
        for (let i = 0; i < operatingHours; i++) {
            const hourIndex = openingHour + i;
            schedule[hourIndex] = Math.round(totalTrucks * rescaledWeights[i]);
        }
    }
    const currentTotal = schedule.reduce((sum, val) => sum + val, 0);
    let difference = totalTrucks - currentTotal;
    let hour = openingHour;
    while(difference !== 0) {
        schedule[hour % closingHour] += Math.sign(difference);
        difference -= Math.sign(difference);
        hour++;
        if (hour >= closingHour) hour = openingHour;
    }
    return schedule;
}

function updateParamsFromUI() {
    PARAMS.SERVERS = {};
    PROCESS_FLOW.forEach(p => PARAMS.SERVERS[p] = parseInt(document.getElementById(`s-${p}`).value));
    
    PARAMS.SERVICE_TIMES_MINUTES = {};
    PROCESS_FLOW.forEach(p => {
        PARAMS.SERVICE_TIMES_MINUTES[p] = { 
            min: parseFloat(document.getElementById(`st-min-${p}`).value), 
            max: parseFloat(document.getElementById(`st-max-${p}`).value) 
        };
    });
    
    const openingHour = parseInt(document.getElementById('opening-hour').value);
    const closingHour = parseInt(document.getElementById('closing-hour').value);
    const totalTrucks = parseInt(document.getElementById('total-trucks-day').value);
    const distType = document.getElementById('distribution-type').value;
    PARAMS.HOURLY_ARRIVALS = generateHourlySchedule(totalTrucks, distType, openingHour, closingHour);
    document.getElementById('schedule-display').textContent = PARAMS.HOURLY_ARRIVALS.join(', ');

    PARAMS.TRAVEL_TIMES_MINUTES = {
        to_access_control_arrival: parseFloat(document.getElementById('tt-to-access_control_arrival').value),
        to_self_arrival_handling: parseFloat(document.getElementById('tt-to-self_arrival_handling').value),
        to_execution: parseFloat(document.getElementById('tt-to-execution').value),
        to_self_departure_handling: parseFloat(document.getElementById('tt-to-self_departure_handling').value),
        to_self_access_control_departure: parseFloat(document.getElementById('tt-to-self_access_control_departure').value),
        to_access_control_departure: parseFloat(document.getElementById('tt-to-access_control_departure').value)
    };
    
    PARAMS.BRANCHING = {
        self_access_arrival_success_percent: parseInt(document.getElementById('branch-self-access-arrival-success').value),
        arrival_success_percent: parseInt(document.getElementById('branch-arrival-success').value),
        departure_success_percent: parseInt(document.getElementById('branch-departure-success').value),
        self_access_departure_success_percent: parseInt(document.getElementById('branch-self-access-departure-success').value)
    };
    
    PARAMS.OPENING_HOUR = openingHour;
    PARAMS.CLOSING_HOUR = closingHour;
    PARAMS.SPEED_MULTIPLIER = parseInt(document.getElementById('speed-multiplier').value) || 500;
    if (PARAMS.SPEED_MULTIPLIER < 1) PARAMS.SPEED_MULTIPLIER = 1;
}

function resetState() {
    truckIdCounter = 1;
    simulationTime = 0;
    trucks = [];
    completedTrucksData = [];

    for (const key in serverPoints) {
        const point = serverPoints[key];
        point.queue = [];
        point.stats = { trucksProcessed: 0, maxQueueLength: 0, totalWaitTime: 0, totalServiceTime: 0, totalBusyTime: 0, maxWaitTime: 0 };
        point.servers.forEach(s => { s.busy = false; s.truckId = null; });
    }

    initializeResultsTable();
    updateResultsDisplay(); 
    draw(); 
}

function fullResetAndSetup() {
    updateParamsFromUI();
    
    const pointDefinitions = {
        // Arrival Flow
        self_access_control_arrival: { name: 'self_access_control_arrival',  x: 150, y: 150, branch: { success_percent: PARAMS.BRANCHING.self_access_arrival_success_percent, success_path: 'self_arrival_handling', failure_path: 'access_control_arrival' }},
        access_control_arrival:    { name: 'access_control_arrival',     x: 150, y: 450, next: 'self_arrival_handling'   },
        self_arrival_handling:     { name: 'self_arrival_handling',      x: 350, y: 150, branch: { success_percent: PARAMS.BRANCHING.arrival_success_percent, success_path: 'execution', failure_path: 'arrival_handling' }},
        arrival_handling:          { name: 'arrival_handling',           x: 350, y: 450, next: 'execution'               },

        // Center point - moved up and centered horizontally
        execution:                 { name: 'execution',                  x: 600, y: 150, next: 'self_departure_handling' },
        
        // Departure Flow - coordinates adjusted for balance
        self_departure_handling:       { name: 'self_departure_handling',    x: 850, y: 150, branch: { success_percent: PARAMS.BRANCHING.departure_success_percent, success_path: 'self_access_control_departure', failure_path: 'departure_handling' }},
        departure_handling:            { name: 'departure_handling',         x: 850, y: 450, next: 'self_access_control_departure'},
        self_access_control_departure: { name: 'self_access_control_departure', x: 1050, y: 150, branch: { success_percent: PARAMS.BRANCHING.self_access_departure_success_percent, success_path: 'access_control_departure', failure_path: 'access_control_departure'}},
        access_control_departure:      { name: 'access_control_departure',   x: 1050, y: 450, next: 'exit'}
    };
    
    const p = pointDefinitions;
    pathDefinitions = {
        'entry->self_access_control_arrival':   [p.self_access_control_arrival],
        'self_access_control_arrival->self_arrival_handling': [p.self_arrival_handling],
        'self_access_control_arrival->access_control_arrival': [p.access_control_arrival],
        'access_control_arrival->self_arrival_handling':  [{x: p.self_arrival_handling.x, y: p.access_control_arrival.y}, p.self_arrival_handling],
        'self_arrival_handling->execution':     [p.execution], // Now a straight line
        'self_arrival_handling->arrival_handling':  [p.arrival_handling],
        'arrival_handling->execution':        [{x: p.execution.x, y: p.arrival_handling.y}, p.execution], // Now a corner
        'execution->self_departure_handling':   [p.self_departure_handling], // Now a straight line
        'self_departure_handling->self_access_control_departure': [p.self_access_control_departure],
        'self_departure_handling->departure_handling': [p.departure_handling],
        'departure_handling->self_access_control_departure': [{x: p.self_access_control_departure.x, y:p.departure_handling.y }, p.self_access_control_departure],
        'self_access_control_departure->access_control_departure': [p.access_control_departure],
        'access_control_departure->exit':       [{x: canvas.width + 40, y: p.access_control_departure.y}],
    };


    for (const key in pointDefinitions) {
        if (PROCESS_FLOW.includes(key)) {
            serverPoints[key] = { ...pointDefinitions[key], servers: [], queue: [] };
            const numServers = PARAMS.SERVERS[key] || 1;
            for (let i = 0; i < numServers; i++) serverPoints[key].servers.push({ busy: false, truckId: null, finishTime: 0 });
        }
    }

    resetState();
}

class Truck {
    constructor() {
        this.id = truckIdCounter++;
        this.x = -40;
        this.y = 150;
        this.status = 'arriving';
        this.destinationKey = 'self_access_control_arrival';
        this.path = getPath('entry', this.destinationKey);
        this.pathIndex = 0;
        this.targetX = this.path[0].x;
        this.targetY = this.path[0].y;
        this.rotation = 0; 
        this.queueEnterTime = 0;
        this.creationTime = simulationTime;
        this.totalServiceTime = 0;
    }

    setNewPath(fromKey, toKey) {
        this.destinationKey = toKey;
        this.path = getPath(fromKey, toKey);
        this.pathIndex = 0;
        if(this.path && this.path.length > 0) {
            this.targetX = this.path[0].x;
            this.targetY = this.path[0].y;
            this.status = 'traveling';
        } else {
            this.status = 'finished';
        }
    }

    move() {
        if (!this.path || this.pathIndex >= this.path.length) {
            return;
        }

        const dx = this.targetX - this.x;
        const dy = this.targetY - this.y;
        
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
             this.rotation = Math.atan2(dy, dx);
        }

        const speed = 3 * (PARAMS.SPEED_MULTIPLIER / 100) + 1;
        const distance = Math.sqrt(dx * dx + dy * dy);
        
        if (distance < speed) {
            this.x = this.targetX;
            this.y = this.targetY;

            this.pathIndex++;
            if (this.pathIndex < this.path.length) {
                this.targetX = this.path[this.pathIndex].x;
                this.targetY = this.path[this.pathIndex].y;
            } else {
                if (this.status === 'exiting') {
                    this.status = 'finished'; 
                } else {
                    this.status = 'queuing';
                    const dest = serverPoints[this.destinationKey];
                    if(dest) {
                        dest.queue.push(this);
                        this.queueEnterTime = simulationTime;
                        if (dest.queue.length > dest.stats.maxQueueLength) dest.stats.maxQueueLength = dest.queue.length;
                    }
                }
            }
        } else {
            this.x += (dx / distance) * speed;
            this.y += (dy / distance) * speed;
        }
    }
}

function update() {
    simulationTime++;
    const currentHour = Math.floor((simulationTime / TICKS_PER_SECOND) / SECONDS_PER_HOUR) % 24;
    const isOpen = (currentHour >= PARAMS.OPENING_HOUR && currentHour < PARAMS.CLOSING_HOUR);
    if (isOpen) {
        const arrivalsThisHour = PARAMS.HOURLY_ARRIVALS[currentHour];
        const arrivalProbabilityPerTick = arrivalsThisHour / (SECONDS_PER_HOUR * TICKS_PER_SECOND);
        if (Math.random() < arrivalProbabilityPerTick) trucks.push(new Truck());
    }
    
    trucks.forEach(truck => {
        if (truck.status === 'traveling' || truck.status === 'arriving' || truck.status === 'exiting') {
            truck.move();
        }
    });

    PROCESS_FLOW.forEach(pointName => {
        const point = serverPoints[pointName]; if(!point) return;
        
        point.servers.forEach(server => {
            if(server.busy) point.stats.totalBusyTime++;
            if (server.busy && simulationTime >= server.finishTime) {
                const finishedTruck = trucks.find(t => t.id === server.truckId);
                if (finishedTruck) {
                    server.busy = false; server.truckId = null;
                    let nextPointName;
                    if (point.branch) {
                        const rand = Math.random() * 100;
                        nextPointName = (rand < point.branch.success_percent) ? point.branch.success_path : point.branch.failure_path;
                    } else {
                        nextPointName = point.next;
                    }

                    if (nextPointName === 'exit') {
                        const turnaroundTime = simulationTime - finishedTruck.creationTime;
                        completedTrucksData.push({ turnaroundTime: turnaroundTime });
                        finishedTruck.setNewPath(pointName, 'exit'); 
                        finishedTruck.status = 'exiting';
                    } else {
                        finishedTruck.setNewPath(pointName, nextPointName);
                    }
                }
            }
        });

        if (point.queue.length > 0) {
            const freeServer = point.servers.find(s => !s.busy);
            if (freeServer) {
                const truck = point.queue.shift(); if (!truck) return;
                point.stats.trucksProcessed++;
                const waitTimeTicks = simulationTime - truck.queueEnterTime;
                point.stats.totalWaitTime += waitTimeTicks;
                if (waitTimeTicks > point.stats.maxWaitTime) {
                    point.stats.maxWaitTime = waitTimeTicks;
                }
                freeServer.busy = true; freeServer.truckId = truck.id; truck.status = 'in_service';
                const sTimeParams = PARAMS.SERVICE_TIMES_MINUTES[pointName];
                const sDurationMins = randomFloat(sTimeParams.min, sTimeParams.max);
                const serviceDurationInTicks = sDurationMins * SECONDS_PER_MINUTE * TICKS_PER_SECOND;
                freeServer.finishTime = simulationTime + serviceDurationInTicks;
                point.stats.totalServiceTime += serviceDurationInTicks;
                truck.totalServiceTime += serviceDurationInTicks;
            }
        }
    });
    trucks = trucks.filter(truck => truck.status !== 'finished');
}

function drawTruck(x, y, rotation, status) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rotation);
    
    const truckWidth = 24;
    const truckHeight = 12;
    
    if (status === 'in_service') {
         ctx.fillStyle = '#2ECC71'; 
         ctx.shadowColor = '#58D68D';
         ctx.shadowBlur = 15;
    } else {
         ctx.fillStyle = '#5DADE2'; 
    }
    
    ctx.fillRect(-truckWidth / 2, -truckHeight / 2, truckWidth, truckHeight);
    
    ctx.fillStyle = '#34495E';
    ctx.fillRect(truckWidth / 2 - 8, -truckHeight / 2, 8, truckHeight);

    ctx.fillStyle = '#2C3E50';
    ctx.fillRect(-truckWidth/2 + 2, -truckHeight/2 - 2, 6, 2); 
    ctx.fillRect(-truckWidth/2 + 2, truckHeight/2, 6, 2); 
    ctx.fillRect(truckWidth/2 - 8, -truckHeight/2 - 2, 6, 2); 
    ctx.fillRect(truckWidth/2 - 8, truckHeight/2, 6, 2); 

    ctx.restore();
    ctx.shadowBlur = 0; 
}

function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1C2833'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const p = serverPoints;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
    ctx.beginPath();
    
    // Arrival Flow
    ctx.moveTo(p.self_access_control_arrival.x, p.self_access_control_arrival.y); ctx.lineTo(p.self_arrival_handling.x, p.self_arrival_handling.y);
    ctx.moveTo(p.self_access_control_arrival.x, p.self_access_control_arrival.y); ctx.lineTo(p.access_control_arrival.x, p.access_control_arrival.y);
    ctx.moveTo(p.access_control_arrival.x, p.access_control_arrival.y); ctx.lineTo(p.self_arrival_handling.x, p.self_arrival_handling.y);
    ctx.moveTo(p.self_arrival_handling.x, p.self_arrival_handling.y); ctx.lineTo(p.execution.x, p.execution.y);
    ctx.moveTo(p.self_arrival_handling.x, p.self_arrival_handling.y); ctx.lineTo(p.arrival_handling.x, p.arrival_handling.y);
    ctx.moveTo(p.arrival_handling.x, p.arrival_handling.y); ctx.lineTo(p.execution.x, p.execution.y); 

    // Connection to Departure
    ctx.moveTo(p.execution.x, p.execution.y); ctx.lineTo(p.self_departure_handling.x, p.self_departure_handling.y);
    
    // Departure Flow
    ctx.moveTo(p.self_departure_handling.x, p.self_departure_handling.y); ctx.lineTo(p.self_access_control_departure.x, p.self_access_control_departure.y);
    ctx.moveTo(p.self_departure_handling.x, p.self_departure_handling.y); ctx.lineTo(p.departure_handling.x, p.departure_handling.y);
    ctx.moveTo(p.departure_handling.x, p.departure_handling.y); ctx.lineTo(p.self_access_control_departure.x, p.self_access_control_departure.y);
    ctx.moveTo(p.self_access_control_departure.x, p.self_access_control_departure.y); ctx.lineTo(p.access_control_departure.x, p.access_control_departure.y);

    ctx.stroke();
    ctx.setLineDash([]); 
    
    PROCESS_FLOW.forEach(pointName => {
        const point = serverPoints[pointName]; if (!point) return;
        ctx.beginPath(); ctx.arc(point.x, point.y, 8, 0, 2 * Math.PI); ctx.fillStyle = 'rgba(255, 255, 255, 0.8)'; ctx.fill();
        if (point.queue.length > 0) {
            const baseRadius = 10; const radius = baseRadius + (point.queue.length * 2.5);
            ctx.beginPath(); ctx.arc(point.x, point.y, radius, 0, 2 * Math.PI);
            const alpha = 0.3 + (Math.sin(simulationTime / 15) * 0.1);
            ctx.fillStyle = `rgba(241, 196, 15, ${alpha})`; ctx.fill();
            ctx.fillStyle = 'white'; ctx.font = `bold ${10 + point.queue.length}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(point.queue.length, point.x, point.y);
        }
        const displayName = capitalizeWords(point.name);
        ctx.fillStyle = '#FFFFFF'; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.fillText(displayName, point.x, point.y + 30);
    });
    
    trucks.forEach(truck => {
        if (truck.status === 'queuing') return; 
        drawTruck(truck.x, truck.y, truck.rotation, truck.status);
    });

    ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = 'bold 16px Arial'; ctx.fillStyle = 'white';
    const totalSeconds = Math.floor(simulationTime / TICKS_PER_SECOND); const day = Math.floor(totalSeconds / SECONDS_PER_DAY); const hour = Math.floor((totalSeconds % SECONDS_PER_DAY) / SECONDS_PER_HOUR); const minute = Math.floor((totalSeconds % SECONDS_PER_HOUR) / 60); const timeString = `Day ${day}, ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    ctx.fillText(timeString, 10, 15);
    const isOpen = (hour >= PARAMS.OPENING_HOUR && hour < PARAMS.CLOSING_HOUR);
    ctx.font = 'bold 14px Arial'; ctx.fillStyle = isOpen ? '#2ECC71' : '#E74C3C';
    ctx.fillText(isOpen ? 'ACCEPTING ARRIVALS' : 'CLOSED FOR NEW ARRIVALS', 10, 35);
}

function updateResultsDisplay() {
    PROCESS_FLOW.forEach(pName => {
        const point = serverPoints[pName]; if (!point) return;
        const avgWaitTicks = point.stats.trucksProcessed > 0 ? (point.stats.totalWaitTime / point.stats.trucksProcessed) : 0;
        const avgWaitMinutes = (avgWaitTicks / TICKS_PER_SECOND) / 60;
        const avgServiceTicks = point.stats.trucksProcessed > 0 ? (point.stats.totalServiceTime / point.stats.trucksProcessed) : 0;
        const avgServiceMinutes = (avgServiceTicks / TICKS_PER_SECOND) / 60;
        
        const totalSimTicks = simulationTime;
        const util24h = totalSimTicks > 0 ? (point.stats.totalBusyTime / (point.servers.length * totalSimTicks)) * 100 : 0;
        
        const openHours = PARAMS.CLOSING_HOUR - PARAMS.OPENING_HOUR;
        const totalOpenTicks = (openHours * SECONDS_PER_HOUR * TICKS_PER_SECOND) * (totalSimTicks / (SECONDS_PER_DAY * TICKS_PER_SECOND));
        const utilOpen = totalOpenTicks > 0 ? (point.stats.totalBusyTime / (point.servers.length * totalOpenTicks)) * 100 : 0;

        const maxWaitMinutes = (point.stats.maxWaitTime / TICKS_PER_SECOND) / 60;

        document.getElementById(`q-curr-${pName}`).textContent = point.queue.length;
        document.getElementById(`q-max-${pName}`).textContent = point.stats.maxQueueLength;
        document.getElementById(`wait-avg-${pName}`).textContent = avgWaitMinutes.toFixed(2);
        document.getElementById(`wait-max-${pName}`).textContent = maxWaitMinutes.toFixed(2);
        document.getElementById(`svc-avg-${pName}`).textContent = avgServiceMinutes.toFixed(2);
        document.getElementById(`util-24h-${pName}`).textContent = util24h.toFixed(1);
        document.getElementById(`util-open-${pName}`).textContent = utilOpen.toFixed(1);
        document.getElementById(`processed-${pName}`).textContent = point.stats.trucksProcessed;
    });
    if (completedTrucksData.length > 0) {
        const totalTurnaroundTicks = completedTrucksData.reduce((sum, data) => sum + data.turnaroundTime, 0);
        const avgTurnaroundTicks = totalTurnaroundTicks / completedTrucksData.length;
        const avgTurnaroundHours = (avgTurnaroundTicks / TICKS_PER_SECOND) / 3600;
        document.getElementById('avg-turnaround-time').textContent = avgTurnaroundHours.toFixed(2);
    } else { document.getElementById('avg-turnaround-time').textContent = "0.00"; }
}

function initializeResultsTable() {
    const tableBody = document.getElementById('results-body'); tableBody.innerHTML = '';
    PROCESS_FLOW.forEach(pName => {
        const displayName = capitalizeWords(pName);
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${displayName}</td>
            <td id="q-curr-${pName}">0</td>
            <td id="q-max-${pName}">0</td>
            <td id="wait-avg-${pName}">0.00</td>
            <td id="wait-max-${pName}">0.00</td>
            <td id="svc-avg-${pName}">0.00</td>
            <td id="util-24h-${pName}">0.0</td>
            <td id="util-open-${pName}">0.0</td>
            <td id="processed-${pName}">0</td>`;
        tableBody.appendChild(row);
    });
}

function stopSimulation() {
    isRunning = false; 
    if (animationFrameId) { cancelAnimationFrame(animationFrameId); animationFrameId = null; }
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    startBtn.disabled = false;
    startBtn.textContent = 'Resume';
    stopBtn.disabled = false;
    stopBtn.textContent = 'Reset';
    stopBtn.classList.add('reset-mode');
}

function gameLoop() {
    if (!isRunning) return;
    const speed = PARAMS.SPEED_MULTIPLIER || 1;
    for (let i = 0; i < speed; i++) {
        update();
    }
    draw();
    if (simulationTime > 0 && simulationTime % 30 === 0) updateResultsDisplay();
    animationFrameId = requestAnimationFrame(gameLoop);
}

function startSimulation() {
    if (isRunning) return;
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');

    if (startBtn.textContent === 'Start') {
        fullResetAndSetup();
    }
    
    isRunning = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    stopBtn.textContent = 'Stop';
    stopBtn.classList.remove('reset-mode');
    startBtn.textContent = 'Resume'; 
    gameLoop();
}

function generateControlInputs() {
    const serverContainer = document.getElementById('server-config-container');
    serverContainer.innerHTML = '';
    const defaultServers = {
        self_access_control_arrival: 3,
        access_control_arrival: 1,
        self_arrival_handling: 3,
        arrival_handling: 1,
        execution: 10,
        self_departure_handling: 3,
        departure_handling: 1,
        self_access_control_departure: 3,
        access_control_departure: 1,
    };
    const defaultServiceTimes = {
      self_access_control_arrival: {min: 0.5, max: 1.5},
      access_control_arrival: {min: 1, max: 3},
      self_arrival_handling: {min: 2, max: 5},
      arrival_handling: {min: 5, max: 10},
      execution: {min: 20, max: 60},
      self_departure_handling: {min: 2, max: 5},
      departure_handling: {min: 5, max: 10},
      self_access_control_departure: {min: 0.5, max: 1.5},
      access_control_departure: {min: 1, max: 2},
    };

    PROCESS_FLOW.forEach(pName => {
        const div = document.createElement('div');
        div.className = 'input-group';
        
        const displayName = capitalizeWords(pName);
        const numServers = defaultServers[pName] || 1; // Fallback to 1
        const sTimes = defaultServiceTimes[pName] || {min: 1, max: 2};

        div.innerHTML = `
            <label style="font-weight: 500; margin-bottom: 8px;">${displayName}</label>
            <div style="display: grid; grid-template-columns: 1fr 1.5fr; gap: 15px; align-items: end;">
                <div>
                    <label for="s-${pName}" style="font-size: 0.85em; color: #6c757d; display: block; margin-bottom: 4px;">Servers</label>
                    <input type="number" id="s-${pName}" value="${numServers}" min="1" title="Number of Servers" style="background-color: #eaf2ff; border-color: #b0cfff;">
                </div>
                <div>
                    <label for="st-min-${pName}" style="font-size: 0.85em; color: #6c757d; display: block; margin-bottom: 4px;">Service Time (Min / Max)</label>
                    <div class="service-time-inputs" style="display: flex; gap: 8px;">
                        <input type="number" id="st-min-${pName}" value="${sTimes.min}" min="0" step="0.5" title="Min Service Time (mins)">
                        <input type="number" id="st-max-${pName}" value="${sTimes.max}" min="0" step="0.5" title="Max Service Time (mins)">
                    </div>
                </div>
            </div>
        `;
        serverContainer.appendChild(div);
    });
}

function setBaselineParameters() {
    try {
        // General
        document.getElementById('total-trucks-day').value = 150;
        document.getElementById('distribution-type').value = 'wave';
        document.getElementById('opening-hour').value = 6;
        document.getElementById('closing-hour').value = 22;

        // Branching
        document.getElementById('branch-self-access-arrival-success').value = 75;
        document.getElementById('branch-arrival-success').value = 75;
        document.getElementById('branch-departure-success').value = 75;
        document.getElementById('branch-self-access-departure-success').value = 75;

        // Travel Times
        document.getElementById('tt-to-execution').value = 7;
        document.getElementById('tt-to-self_departure_handling').value = 7;
        document.getElementById('tt-to-access_control_arrival').value = 2;
        document.getElementById('tt-to-self_arrival_handling').value = 2;
        document.getElementById('tt-to-self_access_control_departure').value = 2;
        document.getElementById('tt-to-access_control_departure').value = 2;
        
        const serverCounts = {
            self_access_control_arrival: 3,
            access_control_arrival: 1,
            self_arrival_handling: 3,
            arrival_handling: 1,
            execution: 10,
            self_departure_handling: 3,
            departure_handling: 1,
            self_access_control_departure: 3,
            access_control_departure: 1,
        };
        for(const serverId in serverCounts) {
            document.getElementById(`s-${serverId}`).value = serverCounts[serverId];
        }


        // Manually update the schedule display to reflect new defaults
        const totalTrucks = parseInt(document.getElementById('total-trucks-day').value);
        const distType = document.getElementById('distribution-type').value;
        const openingHour = parseInt(document.getElementById('opening-hour').value);
        const closingHour = parseInt(document.getElementById('closing-hour').value);
        PARAMS.HOURLY_ARRIVALS = generateHourlySchedule(totalTrucks, distType, openingHour, closingHour);
        document.getElementById('schedule-display').textContent = PARAMS.HOURLY_ARRIVALS.join(', ');

    } catch (e) {
        console.error("Could not set baseline parameters. Are all control panel elements in the HTML?", e);
    }
}

// --- NEW: Export function and its helper ---
function exportResults() {
    let csvContent = "data:text/csv;charset=utf-8,";

    // --- Settings Section ---
    csvContent += "Simulation Settings\n\n";
    csvContent += "Parameter,Value\n";
    csvContent += `Total Trucks per Day,${document.getElementById('total-trucks-day').value}\n`;
    csvContent += `Arrival Distribution,${document.getElementById('distribution-type').selectedOptions[0].text}\n`;
    csvContent += `Operating Hours,${document.getElementById('opening-hour').value}:00 - ${document.getElementById('closing-hour').value}:00\n`;
    csvContent += "\n";
    
    csvContent += "Branching Success Rates (%)\n";
    csvContent += "Branch,Success Rate\n";
    csvContent += `Self Access Arrival,${PARAMS.BRANCHING.self_access_arrival_success_percent}\n`;
    csvContent += `Self Arrival,${PARAMS.BRANCHING.arrival_success_percent}\n`;
    csvContent += `Self Departure,${PARAMS.BRANCHING.departure_success_percent}\n`;
    csvContent += `Self Access Departure,${PARAMS.BRANCHING.self_access_departure_success_percent}\n`;
    csvContent += "\n";

    csvContent += "Server Configurations\n";
    csvContent += "Server Point,Number of Servers,Min Service (m),Max Service (m)\n";
    PROCESS_FLOW.forEach(pName => {
        const displayName = capitalizeWords(pName);
        const servers = PARAMS.SERVERS[pName];
        const sMin = PARAMS.SERVICE_TIMES_MINUTES[pName].min;
        const sMax = PARAMS.SERVICE_TIMES_MINUTES[pName].max;
        csvContent += `${displayName},${servers},${sMin},${sMax}\n`;
    });
    csvContent += "\n\n";

    // --- Results Section ---
    csvContent += "Simulation Results\n\n";
    const avgTurnaround = document.getElementById('avg-turnaround-time').textContent;
    csvContent += `Overall Avg. Turnaround Time (hours),${avgTurnaround}\n\n`;

    // Get table headers
    const headers = Array.from(document.querySelectorAll("#results-table th")).map(th => th.textContent);
    csvContent += headers.join(",") + "\n";
    
    // Get table rows
    PROCESS_FLOW.forEach(pName => {
        let row = [];
        row.push(`"${capitalizeWords(pName)}"`); // Add quotes in case of commas in name
        row.push(document.getElementById(`q-curr-${pName}`).textContent);
        row.push(document.getElementById(`q-max-${pName}`).textContent);
        row.push(document.getElementById(`wait-avg-${pName}`).textContent);
        row.push(document.getElementById(`wait-max-${pName}`).textContent);
        row.push(document.getElementById(`svc-avg-${pName}`).textContent);
        row.push(document.getElementById(`util-24h-${pName}`).textContent);
        row.push(document.getElementById(`util-open-${pName}`).textContent);
        row.push(document.getElementById(`processed-${pName}`).textContent);
        csvContent += row.join(",") + "\n";
    });

    // --- Trigger Download ---
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "truck-simulation-report.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

document.addEventListener('DOMContentLoaded', () => {
    generateControlInputs();

    const setupOptionSelectors = () => {
        const speedControl = document.getElementById('speed-multiplier');
        if(!speedControl) return;

        speedControl.innerHTML = ''; 

        const speedSteps = [1, 5, 10, 25, 50, 100, 250, 500, 750, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000];
        
        speedSteps.forEach(speed => {
             const option = document.createElement('option'); 
             option.value = speed; 
             option.textContent = `${speed}x`; 
             speedControl.appendChild(option);
        });

        speedControl.value = "5000"; 
    };

    setupOptionSelectors();
    setBaselineParameters(); 
    
    // --- Add Export Button ---
    const resultsPanel = document.getElementById('results-panel');
    if (resultsPanel) {
        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export Results (CSV)';
        exportBtn.className = 'sim-button'; // Use existing button styling
        exportBtn.style.backgroundColor = 'var(--primary-color)';
        exportBtn.style.marginTop = '20px';
        exportBtn.style.display = 'block';
        exportBtn.style.width = 'fit-content';
        exportBtn.style.margin = '20px auto 0';

        exportBtn.addEventListener('click', exportResults);
        resultsPanel.appendChild(exportBtn);
    }
    
    const startBtn = document.getElementById('start-btn');
    const stopBtn = document.getElementById('stop-btn');
    
    if (startBtn && stopBtn) {
        startBtn.addEventListener('click', startSimulation);
        stopBtn.addEventListener('click', () => {
            if (isRunning) {
                stopSimulation();
            } else { 
                fullResetAndSetup(); 
                startBtn.textContent = 'Start';
                stopBtn.disabled = true;
                stopBtn.classList.remove('reset-mode');
                stopBtn.textContent = 'Stop';
            }
        });
        
        const arrivalControls = [document.getElementById('total-trucks-day'), document.getElementById('distribution-type'), document.getElementById('opening-hour'), document.getElementById('closing-hour')];
        arrivalControls.forEach(control => {
            control.addEventListener('change', () => {
                const totalTrucks = parseInt(document.getElementById('total-trucks-day').value);
                const distType = document.getElementById('distribution-type').value;
                const openingHour = parseInt(document.getElementById('opening-hour').value);
                const closingHour = parseInt(document.getElementById('closing-hour').value);
                PARAMS.HOURLY_ARRIVALS = generateHourlySchedule(totalTrucks, distType, openingHour, closingHour);
                document.getElementById('schedule-display').textContent = PARAMS.HOURLY_ARRIVALS.join(', ');
            });
        });
        
        fullResetAndSetup();
    } else {
        console.error("A control button was not found.");
    }
});
