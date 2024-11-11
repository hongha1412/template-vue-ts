import Phaser from "phaser";
import { Midi } from "@tonejs/midi";
import * as Tone from "tone";
import RAPIER from "@dimforge/rapier2d-compat";

const SCALE_FACTOR = 50;
const MIN_BOUNCE_VELOCITY = 5;
const PLANK_ROTATIONS = [0, +0.15, -0.15, +0.6, -0.6, +0.3, -0.3, +0.9, -0.9, +1.1, -1.1];
const PLANK_HALF_LENGTH = 0.6;
const PLANK_WIDTH = 0.15;
const BALL_RADIUS = 0.3;
const MAX_SIMULATION_STEPS = 200;
const MS_PER_SIMULATION = 16.66; // ~60fps

interface WorldStateSnapshot {
    ballPosition: RAPIER.Vector2;
    ballVelocity: RAPIER.Vector2;
    planks: Array<{
        position: RAPIER.Vector2;
        angle: number;
        body: RAPIER.RigidBody;
        sprite: Phaser.GameObjects.Rectangle;
    }>;
    time: number;
}

interface StackState {
    noteIndex: number;
    rotationIndex: number;
    rotationPermutation: number[];
    worldState: WorldStateSnapshot;
    simulationSteps: number;
}

export default class MusicMelody extends Phaser.Scene {
    private world!: RAPIER.World;
    private ball!: RAPIER.RigidBody;
    private ballSprite!: Phaser.GameObjects.Arc;
    private cameraFollow!: Phaser.Cameras.Scene2D.Camera;
    private notes: any[] = [];
    private midiLoaded = false;
    private plankGroup!: Phaser.GameObjects.Group;
    private planks: any[] = [];
    private currentNoteIndex = 0;
    private startTime = 0;
    private ballHistory: Array<{position: RAPIER.Vector2, time: number}> = [];
    private readonly historyLength = 100;
    
    // Backtracking related properties
    private stateStack: StackState[] = [];
    private maxPlanksGenerated = 0;
    private noImprovementCount = 0;
    private isGenerating = false;

    constructor() {
        super("MusicMelody");
    }

    // ... [previous methods remain the same until update]

    update(time: number, delta: number) {
        if (!this.world || !this.ball) return;

        if (!this.isGenerating) {
            // Normal game update
            this.world.step();
            this.syncBallSprite();
            this.checkBallPlankCollisions();
        } else {
            // Generation mode
            this.generateWithBacktracking(20); // Process 20 iterations per frame
        }
    }

    private saveWorldState(): WorldStateSnapshot {
        return {
            ballPosition: this.ball.translation(),
            ballVelocity: this.ball.linvel(),
            planks: this.planks.map(p => ({
                position: p.body.translation(),
                angle: p.body.rotation(),
                body: p.body,
                sprite: p.sprite
            })),
            time: performance.now() - this.startTime
        };
    }

    private restoreWorldState(state: WorldStateSnapshot) {
        // Restore ball state
        this.ball.setTranslation(state.ballPosition, true);
        this.ball.setLinvel(state.ballVelocity, true);
        
        // Remove current planks
        this.planks.forEach(p => {
            this.world.removeRigidBody(p.body);
            p.sprite.destroy();
        });
        this.planks = [];

        // Restore planks
        state.planks.forEach(plank => {
            const plankDesc = RAPIER.RigidBodyDesc.fixed()
                .setTranslation(plank.position.x, plank.position.y)
                .setRotation(plank.angle);
            const plankBody = this.world.createRigidBody(plankDesc);
            
            const plankCollider = RAPIER.ColliderDesc.cuboid(PLANK_HALF_LENGTH, PLANK_WIDTH)
                .setRestitution(0.9);
            this.world.createCollider(plankCollider, plankBody);

            const plankSprite = this.add.rectangle(
                plank.position.x * SCALE_FACTOR,
                plank.position.y * SCALE_FACTOR,
                PLANK_HALF_LENGTH * 2 * SCALE_FACTOR,
                PLANK_WIDTH * 2 * SCALE_FACTOR,
                0x00ff00
            ).setDepth(1).setRotation(plank.angle);

            this.planks.push({
                body: plankBody,
                sprite: plankSprite,
                note: this.notes[this.currentNoteIndex],
                angle: plank.angle
            });
        });

        this.syncBallSprite();
    }

    private getRandomPermutation(n: number): number[] {
        const array = Array.from({length: n}, (_, i) => i);
        for (let i = array.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [array[i], array[j]] = [array[j], array[i]];
        }
        return array;
    }

    private async generateWithBacktracking(iterationsPerFrame: number) {
        let iterations = 0;

        while (iterations < iterationsPerFrame && this.stateStack.length > 0) {
            if (this.planks.length > this.maxPlanksGenerated) {
                this.maxPlanksGenerated = this.planks.length;
                this.noImprovementCount = 0;
            } else {
                this.noImprovementCount++;
            }

            // Reset if stuck without improvement
            if (this.noImprovementCount > 2000) {
                if (this.planks.length > this.maxPlanksGenerated - 0.1 * this.notes.length) {
                    this.rewindCurrentState();
                    continue;
                } else {
                    this.noImprovementCount = 0;
                    this.maxPlanksGenerated = this.planks.length;
                }
            }

            const currentState = this.stateStack[this.stateStack.length - 1];
            
            if (currentState.rotationIndex === -1) {
                // Simulate forward until next note or collision
                const success = await this.simulateUntilNextNote(currentState);
                if (!success) {
                    this.rewindCurrentState();
                    continue;
                }
                
                currentState.rotationPermutation = this.getRandomPermutation(PLANK_ROTATIONS.length);
                currentState.rotationIndex = 0;
            }

            // Try placing plank with current rotation
            if (!this.tryPlacePlank(currentState)) {
                currentState.rotationIndex++;
                if (currentState.rotationIndex >= PLANK_ROTATIONS.length) {
                    this.rewindCurrentState();
                }
                continue;
            }

            // Push new state for next note
            this.pushNewState();
            iterations++;
        }

        // If stack is empty, we're done generating
        if (this.stateStack.length === 0) {
            this.isGenerating = false;
            this.startRegularGameplay();
        }
    }

    private async simulateUntilNextNote(state: StackState): Promise<boolean> {
        let steps = 0;
        while (steps < MAX_SIMULATION_STEPS) {
            this.world.step();
            state.simulationSteps++;
            steps++;

            // Check for collisions
            let hasCollision = false;
            this.world.contactPairsWith(this.ball, (contact: RAPIER.ContactPair) => {
                hasCollision = true;
            });

            if (hasCollision) {
                return false;
            }

            // Check if we've reached the next note's time
            const currentTime = performance.now() - this.startTime;
            if (state.noteIndex < this.notes.length && 
                currentTime >= this.notes[state.noteIndex].time) {
                return true;
            }

            // Check position bounds
            const position = this.ball.translation();
            if (position.y < -10 || position.y > 10) { // Adjust bounds as needed
                return false;
            }

            // Add small delay to prevent browser hanging
            if (steps % 10 === 0) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        return true;
    }

    private tryPlacePlank(state: StackState): boolean {
        const position = this.ball.translation();
        const velocity = this.ball.linvel();
        const direction = this.normalizeVector(velocity);
        
        const rotationIndex = state.rotationPermutation[state.rotationIndex];
        const angle = PLANK_ROTATIONS[rotationIndex];
        
        const plankDirection = this.rotateVector(direction, angle);
        const plankCenter = {
            x: position.x + plankDirection.x * (BALL_RADIUS + PLANK_WIDTH + 0.001),
            y: position.y + plankDirection.y * (BALL_RADIUS + PLANK_WIDTH + 0.001)
        };

        const perpendicular = this.rotateVector(plankDirection, Math.PI / 2);
        const plankA = {
            x: plankCenter.x + perpendicular.x * PLANK_HALF_LENGTH,
            y: plankCenter.y + perpendicular.y * PLANK_HALF_LENGTH
        };
        const plankB = {
            x: plankCenter.x - perpendicular.x * PLANK_HALF_LENGTH,
            y: plankCenter.y - perpendicular.y * PLANK_HALF_LENGTH
        };

        // Check historical collisions
        if (!this.checkHistoricalCollisions(plankA, plankB)) {
            return false;
        }

        // Create the plank
        const plankDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(plankCenter.x, plankCenter.y)
            .setRotation(angle);
        const plankBody = this.world.createRigidBody(plankDesc);
        
        const plankCollider = RAPIER.ColliderDesc.cuboid(PLANK_HALF_LENGTH, PLANK_WIDTH)
            .setRestitution(0.9);
        this.world.createCollider(plankCollider, plankBody);

        const plankSprite = this.add.rectangle(
            plankCenter.x * SCALE_FACTOR,
            plankCenter.y * SCALE_FACTOR,
            PLANK_HALF_LENGTH * 2 * SCALE_FACTOR,
            PLANK_WIDTH * 2 * SCALE_FACTOR,
            0x00ff00
        ).setDepth(1).setRotation(angle);

        this.planks.push({
            body: plankBody,
            sprite: plankSprite,
            note: this.notes[state.noteIndex],
            angle
        });

        return true;
    }

    private rewindCurrentState() {
        const state = this.stateStack.pop();
        if (state) {
            for (let i = 0; i < state.simulationSteps; i++) {
                // Rewind physics state
                this.restoreWorldState(state.worldState);
            }
        }
    }

    private pushNewState() {
        this.stateStack.push({
            noteIndex: this.currentNoteIndex + 1,
            rotationIndex: -1,
            rotationPermutation: [],
            worldState: this.saveWorldState(),
            simulationSteps: 0
        });
    }

    private startGeneration() {
        this.isGenerating = true;
        this.stateStack = [{
            noteIndex: 0,
            rotationIndex: -1,
            rotationPermutation: [],
            worldState: this.saveWorldState(),
            simulationSteps: 0
        }];
    }

    private startRegularGameplay() {
        this.isGenerating = false;
        // Reset game state for regular gameplay
        this.currentNoteIndex = 0;
        this.startTime = performance.now();
        // Additional gameplay initialization if needed
    }

    // ... [helper methods remain the same]
}