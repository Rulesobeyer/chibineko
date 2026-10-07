# chibineko

A small 3D cat that chases your cursor around the page. It started as a 3D remake of [oneko.js](https://github.com/adryd325/oneko.js) and picked up a few extras along the way.

Leave it alone and it gets bored. It sits down, scratches behind its ear, wanders over to the edge of the screen to claw at it, yawns, and eventually falls asleep. Click it to pet it. Right-click it (or long-press on a phone) to change colours.


## Add it to your site

Paste this anywhere on the page:

```html
<script src="https://cdn.jsdelivr.net/gh/Rulesobeyer/chibineko@1/chibineko.min.js" data-persist-position></script>
```

Want to host it yourself? Copy `chibineko.js` to your server and point the `src` at it. If your Content-Security-Policy blocks the CDN, host `three.module.min.js` as well and pass its URL in `data-three`.

## Options

Everything is set with `data-*` attributes on the script tag.

| Attribute | Default | |
|---|---|---|
| `data-size` | `64` | Cat height in CSS pixels |
| `data-color` | `#ffffff` | Fur colour |
| `data-outline` | `#1a1a1a` | Outline, eye and mouth colour |
| `data-accent` | `#ffb3c1` | Inner ears, nose and blush |
| `data-speed` | `1` | Speed multiplier |
| `data-persist-position` | off | Remember where the cat was between page loads |
| `data-pet` | `true` | `false` turns off petting and the colour ring, and the cat stops catching clicks altogether |
| `data-prints` | `true` | `false` turns off paw prints |
| `data-blur` | `true` | `false` turns off motion blur |
| `data-three` | jsDelivr three@0.170.0 | Your own copy of `three.module.min.js` |

The cat follows mouse, pen and touch. Like the original, it stays hidden for visitors who have reduced motion turned on.

If a visitor picks a colour from the ring (or the page calls `setColors()`), it's saved in their browser and beats the colour attributes from then on.

## API

```js
chibineko.trigger("groom");   // stand, sit, groom, scratchWall, tired, sleep, alert, pet
chibineko.pet();
chibineko.setColors(chibineko.presets.black); // white, black, ginger, grey, cream, tabby
chibineko.setColors({ color: "#7c8aa0", outline: "#10141f", accent: "#ffb3c1" });
chibineko.colors;             // current { color, outline, accent }
chibineko.state;              // current behaviour
chibineko.timeScale = 0.25;   // slow motion (1 = normal)
chibineko.version;            // "1.0.1"
chibineko.destroy();          // remove the cat
```

## How it works

The cat is drawn with three.js into a small canvas, about three times its size, that moves around the page with it. It's the same trick oneko uses with its `div`. The canvas ignores the mouse. An invisible round hit area sits on top of the cat and catches petting and right-clicks, so the rest of the page stays clickable.

## Credits

[oneko.js](https://github.com/adryd325/oneko.js) by adryd325 (MIT) is the original this is based on. Neko itself was created by Masayuki Koba.

## License

MIT. See [LICENSE](LICENSE).
