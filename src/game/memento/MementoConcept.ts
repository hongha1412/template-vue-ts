// Memento class to store a snapshot of the ball and planks state
export class Memento {
    private ballState: { x: number, y: number, velocityX: number, velocityY: number };
    private plankStates: Array<{ x: number, y: number, rotations: number[], handle: number }>;
    private time: number;

    constructor(ball: any, planks: any[], time: number) {
        this.ballState = {
            x: ball.translation().x,
            y: ball.translation().y,
            velocityX: ball.linvel().x,
            velocityY: ball.linvel().y,
        };

        this.plankStates = planks.map(plank => ({
            x: plank.body.translation().x,
            y: plank.body.translation().y,
            rotations: [...(plank.userData?.rotations || []), plank.body.rotation()],
            handle: plank.body.handle
        }));

        this.time = time;
    }

    getBallState() {
        return this.ballState;
    }

    getPlankStates() {
        return this.plankStates;
    }

    getLastPlankState() {
        return this.plankStates[this.plankStates.length - 1];
    }

    getTime() {
        return this.time;
    }
}

// Originator class to create and restore mementos
export class Originator {
    private ball: any;
    private planks: any[];
    private world: any;
    private planksToRemove: any[] = [];

    constructor(world: any, ball: any, planks: any[]) {
        this.ball = ball;
        this.planks = planks;
        this.world = world;
    }

    saveState(time: number): Memento {
        return new Memento(this.ball, this.planks, time);
    }

    restoreState(memento: Memento, currentPlanks: any[]) {
        try {
            const ballState = memento.getBallState();
            this.ball.setTranslation({ x: ballState.x, y: ballState.y }, true);
            this.ball.setLinvel({ x: ballState.velocityX, y: ballState.velocityY }, true);

            const plankStates = memento.getPlankStates();
            let angle;
            if (currentPlanks.length >= plankStates.length) {
                const plank = currentPlanks.pop();
                this.planksToRemove.push(plank.handle);
                angle = plank.rotations;
            }
            return { time: memento.getTime(), angle };
        } catch (e) {
            console.warn('Restore error', e);
        }
        return { time: 0, handle: -1 };
    }

    getPlanksToRemove() {
        return this.planksToRemove;
    }

    clearPlanksToRemove() {
        this.planksToRemove = [];
    }
}

// Caretaker class to store and manage the history of mementos
export class Caretaker {
    private mementos: Memento[] = [];
    private originator: Originator;

    constructor(originator: Originator) {
        this.originator = originator;
    }

    ballHistory() {
        return this.mementos.map(m => m.getBallState());
    }

    save(time: number) {
        const memento = this.originator.saveState(time);
        this.mementos.push(memento);
        // Limit max mementos
        if (this.mementos.length > 1000) {
            this.mementos.shift();
        }
    }

    undo(currentPlanks: any[]) {
        if (this.mementos.length > 0) {
            let memento;
            while ((memento = this.mementos.pop()) && memento.getPlankStates().length === currentPlanks.length) {
            }
            if (memento) {
                return this.originator.restoreState(memento, currentPlanks);
            }
        }
        return { time: 0, handle: -1 };
    }

    clearHistory() {
        this.mementos = [];
    }

    getPlanksToRemove() {
        return this.originator.getPlanksToRemove();
    }

    clearPlanksToRemove() {
        this.originator.clearPlanksToRemove();
    }
}
