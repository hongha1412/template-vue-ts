import Phaser from "phaser";
import { Midi } from "@tonejs/midi";
import * as Tone from "tone";
import RAPIER from "@dimforge/rapier2d-compat";
import { Caretaker, Originator } from "../memento/MementoConcept";

const SCALE_FACTOR = 50; // Scaling factor to convert pixels to physics meters
const PLANK_ROTATIONS = [0, 0.15, -0.15, 0.6, -0.6, 0.3, -0.3, 0.9, -0.9, 1.1, -1.1];
const MIN_BOUNCE_VELOCITY = 5; // Minimum bounce speed
const MAX_BOUNCE_VELOCITY = 100; // Minimum bounce speed

export default class MusicMelody extends Phaser.Scene {
    private world!: RAPIER.World;
    private ball!: RAPIER.RigidBody;
    private ballSprite!: Phaser.GameObjects.Arc;
    private cameraFollow!: Phaser.Cameras.Scene2D.Camera;
    private notes: any[] = []; // Stores MIDI notes with timing info
    private midiLoaded = false;
    private plankGroup!: Phaser.GameObjects.Group;
    private planks: any[] = [];
    private planksToCheck: any[] = [];
    private currentNoteIndex = 0;
    private caretaker: Caretaker;
    private currentPos: Phaser.Math.Vector2;
    private currentVelocity: Phaser.Math.Vector2;
    private trackTime: number = 0;
    private debugGraphics: Phaser.GameObjects.Graphics;
    private debugRectangles: any[] = [];
    private ballHistory: RAPIER.RigidBody[] = [];

    constructor() {
        super("MusicMelody");
    }

    preload() {
        // Load MIDI file
        this.load.binary("midi", "/midi/MyHeart.mid");
    }

    async create() {
        await RAPIER.init();
        this.debugGraphics = this.add.graphics();

        // Initialize Rapier physics world
        this.world = new RAPIER.World({ x: 0, y: 9.81 });

        // Load and parse MIDI data
        const midiData = this.cache.binary.get("midi");
        const midi = new Midi(midiData);
        this.notes = midi.tracks.flatMap(track => 
            track.notes.map(note => ({
                ...note,
                time: note.time * 1000 // Convert seconds to milliseconds
            }))
        ).sort((a, b) => a.time - b.time);
        
        this.midiLoaded = true;

        // Ensure the first note rings at least 2 seconds after the ball drops
        if (this.notes[0].time < 2000) {
            const delay = 2000 - this.notes[0].time;
            this.notes.forEach(note => note.time += delay);
        }

        // Create the ball in Rapier physics world
        const ballDesc = RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(0, -4)
            .setCcdEnabled(true)
            .setSoftCcdPrediction(5);
        this.ball = this.world.createRigidBody(ballDesc);
        const ballCollider = RAPIER.ColliderDesc.ball(0.3)
            .setRestitution(1) // Set bounce for the ball
            .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS); // Radius of 0.3 meters
        this.world.createCollider(ballCollider, this.ball);

        // Apply initial velocity to the ball
        this.ball.setLinvel({ x: 2, y: 10 }, true); // Adjust x and y for desired initial direction and speed

        // Create Phaser sprite for the ball
        this.ballSprite = this.add.circle(0, -4 * SCALE_FACTOR, 0.3 * SCALE_FACTOR, 0xffff00, 0.5).setDepth(1);
        this.currentPos = new Phaser.Math.Vector2(this.ball.translation().x, this.ball.translation().y);
        this.currentVelocity = new Phaser.Math.Vector2(this.ball.linvel().x, this.ball.linvel().y);

        const originator = new Originator(this.world, this.ball, this.planks);
        this.caretaker = new Caretaker(originator);
        this.caretaker.save(this.trackTime);

        // Set up camera to follow the ball
        this.cameraFollow = this.cameras.main;
        this.cameraFollow.startFollow(this.ballSprite);
        this.cameraFollow.setLerp(0.1, 0.1);

        // Create a group for planks with a max size of 200
        this.plankGroup = this.add.group({
            maxSize: 200,
            runChildUpdate: true
        });

        // Start MIDI Playback
        if (Tone.getContext().state !== 'running') {
            Tone.getContext().resume();
        } else {
            Tone.getTransport().start();
        }
    }

    update(time: number, delta: number) {
        if (!this.world || !this.ball) return;

        while (this.debugRectangles.length > 0) {
            this.debugRectangles.pop().destroy(true);
        }
        // Update Rapier physics world step
        this.world.step();

        this.trackTime += this.world.timestep * 1000;
        this.currentPos.setTo(this.ball.translation().x, this.ball.translation().y);
        this.currentVelocity.setTo(this.ball.linvel().x, this.ball.linvel().y);

        // Create the ball in Rapier physics world
        const ballDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(this.currentPos.x, this.currentPos.y);
        const bhbody = this.world.createRigidBody(ballDesc);
        const ballCollider = RAPIER.ColliderDesc.ball(0.3)
            .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.FIXED_FIXED)
            .setSensor(true);
        this.world.createCollider(ballCollider, bhbody);
        this.ballHistory.push(bhbody);

        // Save ball position to history
        this.caretaker.save(this.trackTime);

        // Sync ball sprite position with Rapier body
        this.ballSprite.setPosition(
            this.currentPos.x * SCALE_FACTOR,
            this.currentPos.y * SCALE_FACTOR
        );

        // Check if at least one plank doesn't intersect with any historical ball
        let anyPlankSafe;
        for (const plank of this.planksToCheck) {
            if (this.isPlankSafe(plank)) {
                anyPlankSafe = plank;
                break; // Exit loop if one plank is safe
            }
        }

        if (anyPlankSafe) {
            // If at least one plank is safe, don't create new sensors
        } else {
            // If no plank is safe, create new sensors for all angles
        }
        this.checkForNextPlank();

        // Check for note targets if MIDI is loaded
        if (this.midiLoaded) {
            this.checkBallPlankCollisions();
        }
        // this.ensureMinimumVelocity();
        // this.ensureMaximumVelocity();

        // Remove planks that are scheduled for removal
        const planksToRemove = this.caretaker.getPlanksToRemove();
        let plankBody;
        for (const plankHandle of planksToRemove) {
            plankBody = this.world.getRigidBody(plankHandle);
            if (plankBody) {
                (plankBody.userData as any)?.destroy(true);
                plankBody.setEnabled(false);
            }
        }
        this.caretaker.clearPlanksToRemove();

        // if (this.world.colliders.len() <= 30)
            this.debug();
        // else
        //     this.debugGraphics.clear();
    }

    private isPlankSafe(plank: RAPIER.Collider): boolean {
        let intersectBall = false;
        this.world.intersectionPairsWith(plank, (otherCollider: RAPIER.Collider) => {
            if (otherCollider.shape.type === RAPIER.ShapeType.Ball) {
                intersectBall = true;
            }
        });
        if (!intersectBall) {
            plank.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DYNAMIC_FIXED);
            plank.setSensor(false);
            plank.setRestitution(1.1);
        }
        return intersectBall;
    }

    private checkForNextPlank(passAngles: number[] = []) {
        if (this.currentNoteIndex >= this.notes.length) return;

        // Get the current time in milliseconds since scene start
        const currentTime = this.trackTime;

        // Get the next note in the sequence
        const nextNote = this.notes[this.currentNoteIndex];

        // If it's time to place the plank for the next note
        if (!nextNote) return;
        if (currentTime >= nextNote.time) {
            this.placePlankForNote(passAngles);
            this.currentNoteIndex++;
        }
    }

    private placePlankForNote(passAngles: number[] = []) {
        const predictedPosition = this.currentPos;

        const direction = new Phaser.Math.Vector2(this.currentVelocity).normalize();
        
        // Shuffle rotations to try randomized plank angles
        Phaser.Utils.Array.Shuffle(PLANK_ROTATIONS);
        
        let newPlank;
        for (const angle of PLANK_ROTATIONS) {
            if (passAngles.includes(angle)) continue;
            const plankDir = direction.rotate(angle);
            const plankCenter = predictedPosition.clone().add(plankDir.clone().multiply({ x: 0.3 + 0.15 * 2 + 1e-3, y: 0.3 + 0.15 * 2 + 1e-3 }));
            const plankA = plankCenter.clone().add(plankDir.clone().rotate(Phaser.Math.DegToRad(90)).multiply({ x: 0.6, y: 0.6 }));
            const plankB = plankCenter.clone().subtract(plankDir.clone().rotate(Phaser.Math.DegToRad(90)).multiply({ x: 0.6, y: 0.6 }));

            if ((newPlank = this.wouldOverlapWithHistory(plankA, plankB, plankCenter, angle))) {
                let plankSprite = this.plankGroup.getFirstDead(false) as Phaser.GameObjects.Rectangle;
                if (!plankSprite) {
                    plankSprite = this.add.rectangle(
                        plankCenter.x * SCALE_FACTOR, 
                        plankCenter.y * SCALE_FACTOR, 
                        0.6 * SCALE_FACTOR * 2, 
                        0.15 * SCALE_FACTOR * 2, 
                        0x00ff00,
                        0.5
                    ).setDepth(1).setRotation(angle);
                    this.plankGroup.add(plankSprite);
                } else {
                    plankSprite.setPosition(plankCenter.x * SCALE_FACTOR, plankCenter.y * SCALE_FACTOR)
                            .setRotation(angle)
                            .setActive(true)
                            .setVisible(true);
                }
                plankSprite.body = newPlank as any;
                (plankSprite as any).rotations = [angle, ...passAngles];
                newPlank.userData = plankSprite;
                this.planks.push(plankSprite);
                break;
            }
        }
        if (!newPlank) {
            console.log('Undo');
            const undoData = this.caretaker.undo(this.planks);
            this.trackTime = undoData.time;
            this.currentNoteIndex--;
            this.checkForNextPlank(undoData.angle);
        }
    }

    private wouldOverlapWithHistory(plankA: Phaser.Math.Vector2, plankB: Phaser.Math.Vector2, plankCenter: Phaser.Math.Vector2, angle: number): false | RAPIER.RigidBody {
        // const pastStates = this.caretaker.ballHistory();
        // for (let i = 1; i < pastStates.length - 1; i++) {
        //     const state1 = pastStates[i];
        //     const state2 = pastStates[i - 1];
        //     const ballPos = new Phaser.Math.Vector2(state1.x, state1.y);

        //     const distanceToSegment = this.pointToSegmentDistance(plankA, plankB, ballPos);
        //     if (distanceToSegment <= (0.3 + 0.6 * 2)) {
        //         return true; // Intersection found
        //     }
        // }
        // return false; // No intersection found
        
        const plankDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(plankCenter.x, plankCenter.y)
            .setRotation(angle);
        const plankBody = this.world.createRigidBody(plankDesc);
        const plankCollider = RAPIER.ColliderDesc.cuboid(0.6, 0.15) // Plank size
            .setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.FIXED_FIXED)
            .setSensor(true);
        const collider = this.world.createCollider(plankCollider, plankBody);

        let intersectBall = false;
        this.world.intersectionPairsWith(collider, (otherCollider: RAPIER.Collider) => {
            if (otherCollider.shape.type === RAPIER.ShapeType.Ball) {
                intersectBall = true;
            }
        });
        if (intersectBall) {
            collider.setEnabled(false);
            return false;
        } else {
            collider.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.DYNAMIC_FIXED);
            collider.setSensor(false);
            collider.setRestitution(1.1);
        }
        return plankBody;

        // const pastStates = this.caretaker.ballHistory();
        // for (let i = 1; i < pastStates.length - 1; i++) {
        //     const state1 = pastStates[i];
        //     const state2 = pastStates[i - 1];
        //     const ballRectangle = this.createRectangleBetweenPoints(state1.x * SCALE_FACTOR, state1.y * SCALE_FACTOR, state2.x * SCALE_FACTOR, state2.y * SCALE_FACTOR, 0.3 * SCALE_FACTOR);
        //     const plankRectangle = this.createRectangleBetweenPoints(plankA.x * SCALE_FACTOR, plankA.y * SCALE_FACTOR, plankB.x * SCALE_FACTOR, plankB.y * SCALE_FACTOR, 0.15 * SCALE_FACTOR);

        //     const distanceToSegment = this.getShortestDistance(ballRectangle, plankRectangle);
        //     if (distanceToSegment <= 10) {
        //         return true; // Intersection found
        //     }
        // }
        // return false; // No intersection found
    }

    private createRectangleBetweenPoints(startX: number, startY: number, endX: number, endY: number, width: number) {
        // Calculate the length and angle
        const length = Phaser.Math.Distance.Between(startX, startY, endX, endY);
        const angle = Phaser.Math.Angle.Between(startX, startY, endX, endY);
     
        // Calculate the center point
        const centerX = (startX + endX) / 2;
        const centerY = (startY + endY) / 2;
     
        // Create the rectangle and set its rotation
        const rectangle = this.add.rectangle(centerX, centerY, length, width, 0x00ff00, 0.3); // Optional color (green here)
        rectangle.setRotation(angle);
        this.debugRectangles.push(rectangle);
     
        return rectangle;
    }

    private getShortestDistance(rect1: Phaser.GameObjects.Rectangle, rect2: Phaser.GameObjects.Rectangle) {
        const horizontalDistance = Math.abs(Math.abs(rect1.geom.centerX - rect2.geom.centerX) - (rect1.width / 2 + rect2.width / 2));
        const verticalDistance = Math.abs(Math.abs(rect1.geom.centerY - rect2.geom.centerY) - (rect1.height / 2 + rect2.height / 2));
     
        return Math.sqrt(horizontalDistance ** 2 + verticalDistance ** 2);
    }

    private addPlank(position: RAPIER.Vector, rotations: number[], createSprite: boolean = true) {
        const plankDesc = RAPIER.RigidBodyDesc.fixed()
            .setTranslation(position.x, position.y)
            .setRotation(rotations[0]);
        const plankBody = this.world.createRigidBody(plankDesc);
        const plankCollider = RAPIER.ColliderDesc.cuboid(0.6, 0.15) // Plank size
            .setRestitution(1.1)
            .setSensor(!createSprite);
        this.world.createCollider(plankCollider, plankBody);

        if (createSprite) {
            let plankSprite = this.plankGroup.getFirstDead(false) as Phaser.GameObjects.Rectangle;
            if (!plankSprite) {
                plankSprite = this.add.rectangle(
                    position.x * SCALE_FACTOR, 
                    position.y * SCALE_FACTOR, 
                    0.6 * SCALE_FACTOR * 2, 
                    0.15 * SCALE_FACTOR * 2, 
                    0x00ff00,
                    0.5
                ).setDepth(1).setRotation(rotations[0]);
                this.plankGroup.add(plankSprite);
            } else {
                plankSprite.setPosition(position.x * SCALE_FACTOR, position.y * SCALE_FACTOR)
                        .setRotation(rotations[0])
                        .setActive(true)
                        .setVisible(true);
            }
            plankSprite.body = plankBody as any;
            (plankSprite as any).rotations = rotations;
            plankBody.userData = plankSprite;
            this.planks.push(plankSprite);
        }
        return plankBody;
    }

    private pointToSegmentDistance(lineStart: Phaser.Math.Vector2, lineEnd: Phaser.Math.Vector2, point: Phaser.Math.Vector2): number {
        const lineVec = lineEnd.clone().subtract(lineStart);
        const pointVec = point.clone().subtract(lineStart);

        const dotProduct = pointVec.dot(lineVec);

        if (dotProduct <= 0) {
            return point.distance(lineStart);
        }

        const squaredLineLength = lineVec.lengthSq();
        if (dotProduct >= squaredLineLength) {
            return point.distance(lineEnd);
        }

        const projection = lineVec.clone().scale(dotProduct / squaredLineLength);
        const closestPoint = lineStart.clone().add(projection);
        return point.distance(closestPoint);
    }

    private checkBallPlankCollisions() {
        this.world.contactPairsWith(this.world.getCollider(this.ball.handle), (otherCollider: RAPIER.Collider) => {
            if (otherCollider) {
                // this.world.removeRigidBody(this.world.getRigidBody(otherCollider.handle));
                // const collidedPlank: any = this.plankGroup.getChildren().find((p: any) => p.body === this.world.getRigidBody(otherCollider.handle));
                // if (collidedPlank && collidedPlank.note) {
                //     Tone.getContext().resume().then(() => {
                //         const synth = new Tone.Synth().toDestination();
                //         synth.triggerAttackRelease(collidedPlank.note.name, "8n");
                //     });
                //     collidedPlank.sprite?.setFillStyle(0x888888);
                //     this.world.removeRigidBody(this.world.getRigidBody(otherCollider.handle));
                // }
            }
        });
    }

    private ensureMinimumVelocity() {
        const velocity = this.currentVelocity;
        const currentSpeed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
        if (currentSpeed < MIN_BOUNCE_VELOCITY) {
            const scaleFactor = MIN_BOUNCE_VELOCITY / currentSpeed;
            this.ball.setLinvel({ x: velocity.x * scaleFactor, y: velocity.y * scaleFactor }, true);
        }
    }

    private ensureMaximumVelocity() {
        const velocity = this.currentVelocity;
        const currentSpeed = Math.sqrt(velocity.x ** 2 + velocity.y ** 2);
        if (currentSpeed > MAX_BOUNCE_VELOCITY) {
            const scaleFactor = MAX_BOUNCE_VELOCITY / currentSpeed;
            this.ball.setLinvel({ x: velocity.x * scaleFactor, y: velocity.y * scaleFactor }, true);
        }
    }

    

    private debug()
    {
        this.debugGraphics.clear();
        const debugRender = this.world.debugRender();
        const vertices = debugRender.vertices;
        const colors = debugRender.colors;

        for (let i = 0; i < vertices.length; i += 4)
        {
            const x1 = vertices[i];
            const y1 = vertices[i + 1];
            const x2 = vertices[i + 2];
            const y2 = vertices[i + 3];

            const colorIndex = i * 2;
            const r = colors[colorIndex];
            const g = colors[colorIndex + 1];
            const b = colors[colorIndex + 2];
            const a = colors[colorIndex + 3];

            this.debugGraphics.lineStyle(2, Phaser.Display.Color.GetColor(r * 255, g * 255, b * 255), a);
            this.debugGraphics.lineBetween(x1 * SCALE_FACTOR, y1 * SCALE_FACTOR, x2 * SCALE_FACTOR, y2 * SCALE_FACTOR);
        }
    }
}
