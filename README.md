# Reassembly Visualizer

A page for looking at the prediction dumps that `scripts/dump_prediction.py`
writes. Pick a folder, choose a dump in the sidebar, and watch the pieces go
from scattered to reassembled.

## Start

1. Double-click `start.bat`. The page opens in your browser at
   http://127.0.0.1:8765. Leave the black window open: closing it stops the page.
2. Click **Open folder** and choose the folder with your dumps. Every subfolder
   that holds `.npz` dumps shows up in the sidebar.

To start on a folder straight away, drag the folder onto `start.bat`, or run

    python serve.py path/to/dumps

Needs Python 3.8 or later, standard library only. Chrome or Edge work best:
there **Open folder** remembers the folder for the next visit. Firefox opens
the folder through an "upload" dialog; nothing is uploaded, the page only
reads the files.

The page also refreshes the folder when you come back to it, so dumps written
while it was open appear by themselves, and a dump rewritten under the same
name is read again.

## Making dumps

Dumps are made with `scripts/dump_prediction.py` from the reassembly
repository, **Equivariance-3D-Reassembly**. That repository is private for now
and cannot be shared. Once it is public, you can run the commands below
yourself, train a model from scratch, and make dumps of your own model's
predictions.

Until then, my own predictions can be downloaded from
[Google Drive](https://drive.google.com/drive/folders/1m2TZpX_lFWkgJ1kIbO9hnv-SJrvYpg92?usp=sharing)
and opened here to inspect them for yourself. For now the folder only holds
the `everyday_compressed` validation subset.

To make a dump, one per scene, run this from the repository root:

    python -m scripts.dump_prediction \
        --root_dir <data> --checkpoint <run>/last.pt \
        --scene everyday_compressed/Mug/<id>/fractured_3 \
        --rotations matched --scatter-seed -1 \
        --out dumps/<run>/<name>.npz

`<data>` is the dataset root, `<run>` the training run folder that holds the
checkpoint, and `<name>` any name for the dump.

`--list --split val` prints the scene keys. `--rotations network` dumps the
rotation head's rotations instead of the ones fitted from the matches;
`--scatter-seed -1` uses the scene's own validation draw.

## Views

Pick any combination in the bar above the view. Each gets a panel, and the
panels turn and zoom together.

| View | Shows |
|---|---|
| Original object | The object before it was broken (the ground truth) |
| Scattered pieces | The pieces as the model was given them, each turned by its random rotation |
| Reassembly | From the scattered pieces to the predicted assembly, on the timeline |
| Rotation only | The predicted rotations with every piece at its true position, so what stays misaligned is rotation error alone |
| Prediction vs original | The predicted assembly, with the original drawn faintly where it should be |

**Colour** pieces by their own colour (the same palette as the repository's
figures), by rotation error, or by position loss, both on a log scale. The
anchor, the largest piece, is set to its true pose before scoring, so it has no
error and is drawn grey.

- *Rotation error*: the angle between the predicted and the true rotation, the
  training's rotation term in degrees.
- *Position loss*: the training's position term (`position_loss` in
  `reassembly/nn/losses.py`): the mean distance from each vertex, turned by the
  predicted rotation, to where it belongs, both centred on the piece, in units
  of the scene's largest piece radius. It is rotation error measured as
  distance, so a large piece counts for more than a chip turned by the same
  angle. Where the solver placed the piece does not enter; that shows in the
  Chamfer column and in RMSE(T). For a dump with the network's rotations, the
  mean over the pieces is the training term for that scene.

**View** holds the scale (fit each view, or the same scale in all of them),
how far apart the scattered pieces are drawn (display only), the up axis,
smooth or faceted surfaces, and Save image.

The panel on the right lists the dump's scene, checkpoint and scores, and
one row per piece with its rotation error, position loss and Chamfer distance
(red when the piece is not placed, at 0.01 or more). Click a column to sort by
it. Hover a row to light the piece, click it to pick it out. Hovering a piece
in the view shows its numbers too.

## Keys

| Key | Does |
|---|---|
| Space | Play or pause |
| Left, Right | Step the reassembly back or forward |
| Home, End | Jump to scattered or assembled |
| J, K | Next or previous dump |
| C | Colour by piece, rotation error or position loss |
| R | Reset the view |
| Esc | Show every piece again |
| ? | All shortcuts |

In the view: drag to turn, scroll to zoom, right-drag to move, click a piece
to pick it out, double-click to reset. `.npz` files dropped on the view open
without a folder.

## Files

    index.html, css/, js/   the page
    serve.py, start.bat     the local server and its launcher
    samples/demo-vase.npz   a made-up dump for "Try the demo"
    vendor/                 three.js r186 and fflate (MIT), IBM Plex Sans (SIL OFL)

The server listens on 127.0.0.1 only. Dumps are read by your browser from your
disk and go nowhere else.
