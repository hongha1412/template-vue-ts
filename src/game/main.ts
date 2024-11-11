import { AUTO, Game } from 'phaser';
import MusicMelody from './scenes/MusicMelody';

//  Find out more information about the Game Config at:
//  https://newdocs.phaser.io/docs/3.70.0/Phaser.Types.Core.GameConfig
const config: Phaser.Types.Core.GameConfig = {
    type: AUTO,
    width: 1024,
    height: 768,
    parent: 'game-container',
    backgroundColor: '#028af8',
    scale: {
        autoCenter: Phaser.Scale.CENTER_BOTH,
        mode: Phaser.Scale.FIT,
    },
    scene: MusicMelody
};

const StartGame = (parent: string) => {

    return new Game({ ...config, parent });

}

export default StartGame;
