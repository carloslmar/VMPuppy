# VMPuppy

Disclaimer: Some AI was used to do repetitive tasks.

Turns your phone into the VMU for Flycast. While it's **docked**, the phone shows the VMU screen live during gameplay. **Eject** it and the phone *is* the VMU: tap the buttons to play VMU minigames on the same save data, then **dock** it again to hand the results back to the game. It works like DreamPotato, but on ya phone!

## What you need

- Flycast 2.7+ or Hollycast.
- Python 3.8+. No extra packages are needed.
- The VMU BIOS: `american_v1.05.bin`, the same file DreamPotato uses. You only need it for ejected play; showing the screen while docked works without it.

## Setup

1. Put `american_v1.05.bin` in this folder, next to `vmu_bridge.py`.
2. *(Optional: keep your existing saves.)* Before the first run, copy Flycast's VMU file (for example `vmu_save_A1.bin` in Flycast's data folder) to `saves/vmu_A1.bin`. Otherwise the bridge creates a fresh, formatted VMU.
3. In Flycast, open **Settings → Controls**. For controller A, set the first expansion slot to **DreamPotato**, and turn **Use Physical VMU Storage** **ON** so the game saves to this VMU.
4. Run `python vmu_bridge.py`. It prints an address such as `http://192.168.1.20:8080`; open that on your phone (same Wi-Fi). On Windows, allow Python on private networks when asked.
5. Start a game.

## Playing

- **Eject / Dock** (top right) takes the VMU out of the controller or puts it back. Holding **SLEEP** for one second does the same, like DreamPotato.
- While ejected, all VMU buttons work, including several fingers at once (the D-pad accepts diagonals and sliding). The page vibrates on press (Android); you can turn that off in settings.
- **Tap the VMU's screen** for full screen.
- **Gear** opens the settings: controller port, screen colour, sound, LCD ghosting, rotate, keep screen on and vibration.
- Saves you make on the phone are sent to the PC within about a second. If you close the page while ejected, opening it again resumes where you were.
- Only one phone holds an ejected VMU. Another phone sees "Use it here" and can take it over.

## Flycast or Hollycast?

- **Hollycast** is told when you eject or dock, so the game sees the VMU being removed and inserted, exactly like real hardware. In Hollycast's controller settings choose **DreamPotato**, keep **Use External VMU Storage** on, and turn **DreamPotato Integrated Mode** **off** so Hollycast connects to this bridge instead of launching DreamPotato.
- **Flycast** only checks for the VMU when a game starts. Eject and dock still work for playing minigames and moving saves, but:
  - the running game won't notice the VMU was removed;
  - it may not see changes you made on the phone until you restart the game;
  - dock the VMU before starting a game. 

## Notes and limits

- The VMU clock pauses while the page is in the background.

## Credits

The VMU emulator in `vmu-core.js` is a port of the core of [DreamPotato](https://github.com/RikkiGibson/DreamPotato) by Rikki Gibson (MIT License). The dock/eject and save protocol follows DreamPotato and Flycast/Hollycast's `dreampotato.cpp`.
